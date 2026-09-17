import pg from 'pg'
import type { Env } from './env.js'
import { log } from './log.js'

export class EmbeddingError extends Error {}

export interface EmbeddingStore {
  fetch(assetIds: string[]): Promise<Map<string, Float64Array>>
  close(): Promise<void>
  /** Width of the vectors seen so far, or 0 before the first row. */
  dimension(): number
}

/**
 * Reads CLIP vectors out of Immich's `smart_search`. The column is pgvector, cast to text so no
 * pgvector client binding is needed, and the width is learned from the first row rather than assumed.
 */
export class PgEmbeddingStore implements EmbeddingStore {
  private readonly pool: pg.Pool
  private dim = 0

  constructor(env: Env) {
    this.pool = new pg.Pool({
      host: env.pg.host,
      port: env.pg.port,
      user: env.pg.user,
      password: env.pg.password,
      database: env.pg.database,
      max: 4,
      application_name: 'immich-auto-rating',
    })
  }

  dimension(): number {
    return this.dim
  }

  async fetch(assetIds: string[]): Promise<Map<string, Float64Array>> {
    const out = new Map<string, Float64Array>()
    if (assetIds.length === 0) return out
    const chunkSize = 2000
    for (let i = 0; i < assetIds.length; i += chunkSize) {
      const chunk = assetIds.slice(i, i + chunkSize)
      const res = await this.pool.query<{ assetId: string; embedding: string }>(
        'SELECT "assetId", embedding::text AS embedding FROM smart_search WHERE "assetId" = ANY($1::uuid[])',
        [chunk],
      )
      for (const row of res.rows) out.set(row.assetId, this.take(row.embedding))
    }
    const missing = assetIds.length - out.size
    if (missing > 0) log.warn('embeddings.missing', { missing, asked: assetIds.length })
    return out
  }

  private take(literal: string): Float64Array {
    const v = parseVector(literal)
    if (this.dim === 0) this.dim = v.length
    else if (v.length !== this.dim) {
      throw new EmbeddingError(`smart_search holds mixed widths: saw ${this.dim} then ${v.length}`)
    }
    return normalise(v)
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

/** pgvector's text literal is `[0.1,-0.2,...]`. */
export function parseVector(literal: string): Float64Array {
  const trimmed = literal.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    throw new EmbeddingError(`not a pgvector literal: ${trimmed.slice(0, 40)}`)
  }
  const parts = trimmed.slice(1, -1).split(',')
  const out = new Float64Array(parts.length)
  for (let i = 0; i < parts.length; i++) {
    const n = Number(parts[i])
    if (!Number.isFinite(n)) throw new EmbeddingError(`non-finite component at ${i}`)
    out[i] = n
  }
  return out
}

export function normalise(v: Float64Array): Float64Array {
  let sum = 0
  for (const x of v) sum += x * x
  const norm = Math.sqrt(sum)
  if (norm === 0) return v
  const out = new Float64Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm
  return out
}

export function cosine(a: Float64Array, b: Float64Array): number {
  if (a.length !== b.length) throw new EmbeddingError(`cosine over ${a.length} and ${b.length}`)
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!
  return dot
}
