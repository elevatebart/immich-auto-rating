import { describe, expect, it, vi } from 'vitest'
import { ImmichClient, isPrincipal, isStackPrimary } from '../src/immich.js'
import { asset, searchPage } from './fixtures/assets.js'

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

describe('candidate filtering', () => {
  it('keeps an unstacked asset', () => {
    expect(isStackPrimary(asset({ id: 'a' }))).toBe(true)
  })

  it('keeps the primary of a stack and drops the rest', () => {
    const stack = { id: 's1', primaryAssetId: 'a', assetCount: 3 }
    expect(isStackPrimary(asset({ id: 'a', stack }))).toBe(true)
    expect(isStackPrimary(asset({ id: 'b', stack }))).toBe(false)
    expect(isStackPrimary(asset({ id: 'c', stack }))).toBe(false)
  })

  it('drops videos, archived, hidden and trashed assets', () => {
    expect(isPrincipal(asset({ id: 'v', type: 'VIDEO' }))).toBe(false)
    expect(isPrincipal(asset({ id: 'ar', visibility: 'archive', isArchived: true }))).toBe(false)
    expect(isPrincipal(asset({ id: 'h', visibility: 'hidden' }))).toBe(false)
    expect(isPrincipal(asset({ id: 'l', visibility: 'locked' }))).toBe(false)
    expect(isPrincipal(asset({ id: 't', isTrashed: true }))).toBe(false)
    expect(isPrincipal(asset({ id: 'good' }))).toBe(true)
  })
})

describe('ImmichClient', () => {
  it('sends the v3 filter DSL, not the deprecated flat fields', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => ok(searchPage([asset({ id: 'a' })])))
    const client = new ImmichClient('http://immich', 'key', { fetchImpl: fetchImpl as never })
    await client.searchCandidates()

    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string)
    expect(body.filter).toEqual({
      type: { eq: 'IMAGE' },
      visibility: { eq: 'timeline' },
      trashedAt: { eq: null },
    })
    expect(body).not.toHaveProperty('type')
    expect(body).not.toHaveProperty('visibility')
    expect(body.withExif).toBe(true)
    expect(body.withPeople).toBe(true)
  })

  it('follows nextCursor until it runs out', async () => {
    const pages = [
      searchPage([asset({ id: 'a' })], 'c1'),
      searchPage([asset({ id: 'b' })], 'c2'),
      searchPage([asset({ id: 'c' })], null),
    ]
    let n = 0
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => ok(pages[n++]!))
    const client = new ImmichClient('http://immich', 'key', { fetchImpl: fetchImpl as never })

    const out = await client.searchCandidates()
    expect(out.map((a) => a.id)).toEqual(['a', 'b', 'c'])
    expect(JSON.parse((fetchImpl.mock.calls[1]![1] as RequestInit).body as string).cursor).toBe('c1')
    expect(JSON.parse((fetchImpl.mock.calls[2]![1] as RequestInit).body as string).cursor).toBe('c2')
  })

  it('writes ratings through the bulk endpoint', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 204 }))
    const client = new ImmichClient('http://immich', 'key', { fetchImpl: fetchImpl as never })
    await client.updateRatings(['a', 'b'], 4)

    const [url, init] = fetchImpl.mock.calls[0]! as [string, RequestInit]
    expect(url).toBe('http://immich/api/assets')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({ ids: ['a', 'b'], rating: 4 })
  })

  it('retries a 429 and then succeeds', async () => {
    const responses = [
      new Response('slow down', { status: 429, headers: { 'retry-after': '0' } }),
      ok({ ok: true }),
    ]
    let n = 0
    const fetchImpl = vi.fn(async () => responses[n++]!)
    const sleepImpl = vi.fn(async () => {})
    const client = new ImmichClient('http://immich', 'key', {
      fetchImpl: fetchImpl as never,
      sleepImpl,
    })

    await expect(client.request('GET', '/albums')).resolves.toEqual({ ok: true })
    expect(sleepImpl).toHaveBeenCalledOnce()
  })

  it('gives up after maxRetries and reports the status', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 503 }))
    const client = new ImmichClient('http://immich', 'key', {
      fetchImpl: fetchImpl as never,
      sleepImpl: async () => {},
      maxRetries: 2,
    })
    await expect(client.request('GET', '/albums')).rejects.toThrow(/503/)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('does not retry a 400', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad rating', { status: 400 }))
    const client = new ImmichClient('http://immich', 'key', { fetchImpl: fetchImpl as never })
    await expect(client.updateRatings(['a'], 0)).rejects.toThrow(/400/)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })
})
