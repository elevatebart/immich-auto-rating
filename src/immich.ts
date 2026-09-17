import type { Asset } from './types.js'
import { log } from './log.js'

export class ImmichError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message)
  }
}

export interface Album {
  id: string
  albumName: string
  assetCount: number
}

const RETRYABLE = new Set([429, 500, 502, 503, 504])
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(() => r(), ms))

export interface ClientOptions {
  maxRetries?: number
  fetchImpl?: typeof fetch
  /** Injected in tests so backoff does not actually wait. */
  sleepImpl?: (ms: number) => Promise<void>
}

export class ImmichClient {
  private readonly maxRetries: number
  private readonly doFetch: typeof fetch
  private readonly wait: (ms: number) => Promise<void>

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    opts: ClientOptions = {},
  ) {
    this.maxRetries = opts.maxRetries ?? 5
    this.doFetch = opts.fetchImpl ?? fetch
    this.wait = opts.sleepImpl ?? sleep
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}/api${path}`
    let attempt = 0
    for (;;) {
      const res = await this.doFetch(url, {
        method,
        headers: {
          'x-api-key': this.apiKey,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      if (res.ok) return res.status === 204 ? (undefined as T) : ((await res.json()) as T)

      const text = await res.text().catch(() => '')
      if (RETRYABLE.has(res.status) && attempt < this.maxRetries) {
        const backoff = retryDelayMs(res, attempt)
        log.warn('immich.retry', { method, path, status: res.status, attempt, backoff })
        await this.wait(backoff)
        attempt++
        continue
      }
      throw new ImmichError(`${method} ${path} failed with ${res.status}`, res.status, text.slice(0, 500))
    }
  }

  /** Every principal image: type IMAGE, timeline, untrashed, and primary of its stack if stacked. */
  async searchCandidates(extra: Record<string, unknown> = {}): Promise<Asset[]> {
    const filter = {
      type: { eq: 'IMAGE' },
      visibility: { eq: 'timeline' },
      trashedAt: { eq: null },
      ...extra,
    }
    const all: Asset[] = []
    let cursor: string | undefined
    for (;;) {
      const page = await this.request<SearchResponse>('POST', '/search/metadata', {
        filter,
        withExif: true,
        withPeople: true,
        size: 1000,
        ...(cursor ? { cursor } : {}),
      })
      all.push(...page.assets.items)
      cursor = page.assets.nextCursor ?? undefined
      if (!cursor || page.assets.items.length === 0) break
    }
    return all
  }

  async albumAssetIds(albumId: string): Promise<Set<string>> {
    const assets = await this.searchCandidates({ albumIds: { any: [albumId] } })
    return new Set(assets.map((a) => a.id))
  }

  async getAlbums(): Promise<Album[]> {
    return this.request<Album[]>('GET', '/albums')
  }

  async createAlbum(albumName: string, description: string): Promise<Album> {
    return this.request<Album>('POST', '/albums', { albumName, description })
  }

  async addAssetsToAlbum(albumId: string, ids: string[]): Promise<void> {
    await this.request('PUT', `/albums/${albumId}/assets`, { ids })
  }

  async removeAssetsFromAlbum(albumId: string, ids: string[]): Promise<void> {
    await this.request('DELETE', `/albums/${albumId}/assets`, { ids })
  }

  /** One call per rating bucket. Immich v3 rejects 0, so callers must send 1..5 or null. */
  async updateRatings(ids: string[], rating: number | null): Promise<void> {
    await this.request('PUT', '/assets', { ids, rating })
  }

  async getPeople(): Promise<{ id: string; name: string }[]> {
    const res = await this.request<{ people: { id: string; name: string }[] }>(
      'GET',
      '/people?withHidden=false&size=1000',
    )
    return res.people ?? []
  }

  /** Reads machineLearning.clip.modelName. Needs adminConfig.read, so callers fall back to config. */
  async clipModelName(): Promise<string> {
    const cfg = await this.request<AdminConfig>('GET', '/admin/config')
    const name = cfg.machineLearning?.clip?.modelName
    if (!name) throw new ImmichError('admin config carries no machineLearning.clip.modelName', 200, '')
    return name
  }
}

// `total` is the size of the page, not the match count, so never read it. Page until nextCursor
// is null and count the items instead. Verified against 3.2.0, see docs/immich-contract.md.
interface SearchResponse {
  assets: { items: Asset[]; nextCursor: string | null; total: number; count: number }
}

interface AdminConfig {
  machineLearning?: { clip?: { modelName?: string } }
}

function retryDelayMs(res: Response, attempt: number): number {
  const header = res.headers.get('retry-after')
  if (header) {
    const secs = Number(header)
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 60_000)
  }
  const jitter = Math.floor(Math.random() * 250)
  return Math.min(2 ** attempt * 500, 30_000) + jitter
}

/** True when the asset is the one a stack shows, or is in no stack at all. */
export function isStackPrimary(asset: Asset): boolean {
  return !asset.stack || asset.stack.primaryAssetId === asset.id
}

/** Defence in depth: the search filter already excludes these, fixtures and stacks do not. */
export function isPrincipal(asset: Asset): boolean {
  return (
    asset.type === 'IMAGE' &&
    asset.visibility === 'timeline' &&
    !asset.isTrashed &&
    !asset.isArchived &&
    isStackPrimary(asset)
  )
}
