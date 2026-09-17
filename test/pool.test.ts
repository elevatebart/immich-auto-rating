import { describe, expect, it, vi } from 'vitest'
import { applyPool, chunks, findAlbum, planPool } from '../src/pool.js'
import type { ImmichClient } from '../src/immich.js'

const set = (...ids: string[]) => new Set(ids)

describe('planPool', () => {
  it('adds what climbed to the threshold', () => {
    const plan = planPool(set('a', 'b'), set('a'), set('a', 'b'), true)
    expect(plan.add).toEqual(['b'])
    expect(plan.remove).toEqual([])
  })

  it('removes what dropped below the threshold', () => {
    const plan = planPool(set('a'), set('a', 'b'), set('a', 'b'), true)
    expect(plan.add).toEqual([])
    expect(plan.remove).toEqual(['b'])
  })

  it('leaves assets this run never looked at alone', () => {
    // 'old' is in the album but was not scored, so it is not evidence of a drop.
    const plan = planPool(set('a'), set('a', 'old'), set('a'), true)
    expect(plan.remove).toEqual([])
  })

  it('asks for the album when it is missing', () => {
    expect(planPool(set('a'), set(), set('a'), false).createAlbum).toBe(true)
    expect(planPool(set('a'), set(), set('a'), true).createAlbum).toBe(false)
  })

  it('is a noop when nothing moved', () => {
    const plan = planPool(set('a', 'b'), set('a', 'b'), set('a', 'b'), true)
    expect(plan.add).toEqual([])
    expect(plan.remove).toEqual([])
  })

  it('handles an empty library', () => {
    const plan = planPool(set(), set(), set(), false)
    expect(plan).toEqual({ add: [], remove: [], createAlbum: true })
  })
})

describe('findAlbum', () => {
  it('matches on the exact album name', () => {
    const albums = [
      { id: '1', albumName: 'Wallpaper pool', assetCount: 3 },
      { id: '2', albumName: 'Wallpaper pool old', assetCount: 1 },
    ]
    expect(findAlbum(albums, 'Wallpaper pool')!.id).toBe('1')
    expect(findAlbum(albums, 'Nothing')).toBeUndefined()
  })
})

describe('applyPool', () => {
  const stub = () => ({
    createAlbum: vi.fn(async () => ({ id: 'new', albumName: 'Wallpaper pool', assetCount: 0 })),
    addAssetsToAlbum: vi.fn(async () => {}),
    removeAssetsFromAlbum: vi.fn(async () => {}),
  })

  it('creates the album on first use, then fills it', async () => {
    const client = stub()
    const out = await applyPool(
      client as unknown as ImmichClient,
      'Wallpaper pool',
      { add: ['a', 'b'], remove: [], createAlbum: true },
      undefined,
    )
    expect(client.createAlbum).toHaveBeenCalledOnce()
    expect(client.addAssetsToAlbum).toHaveBeenCalledWith('new', ['a', 'b'])
    expect(out).toMatchObject({ albumId: 'new', added: 2, removed: 0 })
  })

  it('does not create an empty album for nothing', async () => {
    const client = stub()
    const out = await applyPool(
      client as unknown as ImmichClient,
      'Wallpaper pool',
      { add: [], remove: [], createAlbum: true },
      undefined,
    )
    expect(client.createAlbum).not.toHaveBeenCalled()
    expect(out.added).toBe(0)
  })

  it('chunks large add and remove lists', async () => {
    const client = stub()
    const add = Array.from({ length: 1200 }, (_, i) => `a${i}`)
    await applyPool(
      client as unknown as ImmichClient,
      'Wallpaper pool',
      { add, remove: ['x'], createAlbum: false },
      'album1',
    )
    expect(client.addAssetsToAlbum).toHaveBeenCalledTimes(3)
    expect(client.removeAssetsFromAlbum).toHaveBeenCalledWith('album1', ['x'])
  })
})

describe('chunks', () => {
  it('splits evenly and keeps the remainder', () => {
    expect(chunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunks([], 2)).toEqual([])
  })
})
