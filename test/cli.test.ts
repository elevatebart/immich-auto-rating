import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import type { Config } from '../src/types.js'
import type { Plan } from '../src/run.js'
import { asset, testConfig } from './fixtures/assets.js'

const mocks = vi.hoisted(() => ({
  config: null as Config | null,
  plan: null as Plan | null,
  client: {
    searchCandidates: vi.fn(),
    getAlbums: vi.fn(),
    albumAssetIds: vi.fn(),
    addAssetsToAlbum: vi.fn(),
    removeAssetsFromAlbum: vi.fn(),
    updateRatings: vi.fn(),
    request: vi.fn(),
  },
  state: {
    transaction: (fn: () => void) => fn(),
    recordWrite: vi.fn(),
    markFirstRunDone: vi.fn(),
    freeze: vi.fn(),
    close: vi.fn(),
  },
  store: { close: vi.fn() },
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../src/config.js', async (original) => ({
  ...await original<typeof import('../src/config.js')>(),
  loadConfig: () => mocks.config,
}))
vi.mock('../src/env.js', () => ({ readEnv: () => ({ immichUrl: 'http://immich', stateDir: ':memory:' }) }))
vi.mock('../src/log.js', () => ({ log: mocks.log }))
vi.mock('../src/immich.js', async (original) => ({
  ...await original<typeof import('../src/immich.js')>(),
  ImmichClient: vi.fn(function () { return mocks.client }),
}))
vi.mock('../src/state.js', async (original) => ({
  ...await original<typeof import('../src/state.js')>(),
  State: { open: () => mocks.state },
}))
vi.mock('../src/run.js', () => ({
  openStore: () => mocks.store,
  prepare: async () => ({ candidates: [{}, {}, {}, {}] }),
  score: async () => mocks.plan,
  refit: vi.fn(),
}))

const originalArgv = process.argv
let exit: MockInstance<typeof process.exit>

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
  process.argv = [process.execPath, 'cli.js', 'apply']
  mocks.config = { ...testConfig, pool: { ...testConfig.pool, album: 'Photo frame' } }
  mocks.plan = {
    scored: [
      { id: 'auto5', rating: 5, uncertainty: 0.1, raw: 0.9, reason: 'zero-shot' },
      { id: 'auto4', rating: 4, uncertainty: 0.1, raw: 0.8, reason: 'zero-shot' },
    ],
    mode: 'zero-shot', labelCount: 2, skippedFrozen: 2, noEmbedding: 0,
  }
  mocks.client.getAlbums.mockResolvedValue([{ id: 'album', albumName: 'Photo frame' }])
  mocks.client.albumAssetIds.mockResolvedValue(new Set(['existing', 'auto4', 'auto5']))
  mocks.client.searchCandidates.mockResolvedValue([
    asset({ id: 'auto5', exifInfo: { rating: 5 } }),
    asset({ id: 'manual5', exifInfo: { rating: 5 } }),
    asset({ id: 'no-embedding', exifInfo: { rating: 5 } }),
    asset({ id: 'archived', visibility: 'archive', isArchived: true }),
    asset({ id: 'trashed', isTrashed: true }),
    asset({ id: 'secondary', stack: { id: 'stack', primaryAssetId: 'primary', assetCount: 2 } }),
  ])
  mocks.client.addAssetsToAlbum.mockResolvedValue(undefined)
  mocks.client.removeAssetsFromAlbum.mockResolvedValue(undefined)
  mocks.client.updateRatings.mockResolvedValue(undefined)
  mocks.store.close.mockResolvedValue(undefined)
})

afterEach(() => {
  process.argv = originalArgv
  vi.restoreAllMocks()
})

async function runCli() {
  await import('../src/cli.js')
  await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce())
}

describe('CLI album options', () => {
  it('keeps the default scored-only pool and removes scored photos below the threshold', async () => {
    await runCli()
    expect(exit).toHaveBeenCalledWith(0)
    expect(mocks.client.searchCandidates).not.toHaveBeenCalled()
    expect(mocks.client.addAssetsToAlbum).not.toHaveBeenCalled()
    expect(mocks.client.removeAssetsFromAlbum).toHaveBeenCalledWith('album', ['auto4'])
  })

  it('adds saved manual ratings after writes and preserves every existing member in add-only mode', async () => {
    mocks.config!.pool.includeManualRatings = true
    mocks.config!.pool.removeBelowThreshold = false
    await runCli()
    expect(exit).toHaveBeenCalledWith(0)
    expect(mocks.client.searchCandidates).toHaveBeenCalledWith({ rating: { gte: 5 } })
    expect(mocks.client.updateRatings.mock.invocationCallOrder.at(-1))
      .toBeLessThan(mocks.client.searchCandidates.mock.invocationCallOrder[0]!)
    expect(mocks.client.addAssetsToAlbum).toHaveBeenCalledWith('album', ['manual5', 'no-embedding'])
    expect(mocks.client.removeAssetsFromAlbum).not.toHaveBeenCalled()
    expect(mocks.client.updateRatings.mock.calls.flatMap(([ids]) => ids)).toEqual(['auto5', 'auto4'])
  })

  it('can include manual ratings while retaining removal of scored photos', async () => {
    mocks.config!.pool.includeManualRatings = true
    await runCli()
    expect(exit).toHaveBeenCalledWith(0)
    expect(mocks.client.addAssetsToAlbum).toHaveBeenCalledWith('album', ['manual5', 'no-embedding'])
    expect(mocks.client.removeAssetsFromAlbum).toHaveBeenCalledWith('album', ['auto4'])
  })

  it('adds manual ratings even when every photo is frozen or lacks an embedding', async () => {
    mocks.config!.pool.includeManualRatings = true
    mocks.plan!.scored = []
    await runCli()
    expect(exit).toHaveBeenCalledWith(0)
    expect(mocks.client.updateRatings).not.toHaveBeenCalled()
    expect(mocks.client.addAssetsToAlbum).toHaveBeenCalledWith('album', ['manual5', 'no-embedding'])
    expect(mocks.client.removeAssetsFromAlbum).not.toHaveBeenCalled()
  })

  it('skips the saved-rating query when no pool album is configured', async () => {
    mocks.config!.pool.album = ''
    mocks.config!.pool.includeManualRatings = true
    await runCli()
    expect(exit).toHaveBeenCalledWith(0)
    expect(mocks.client.searchCandidates).not.toHaveBeenCalled()
    expect(mocks.client.getAlbums).not.toHaveBeenCalled()
  })

  it('reports a saved-rating query failure without modifying the album', async () => {
    mocks.config!.pool.includeManualRatings = true
    mocks.client.searchCandidates.mockRejectedValueOnce(new Error('unavailable'))
    await runCli()
    expect(exit).toHaveBeenCalledWith(1)
    expect(mocks.client.addAssetsToAlbum).not.toHaveBeenCalled()
    expect(mocks.client.removeAssetsFromAlbum).not.toHaveBeenCalled()
    expect(mocks.store.close).toHaveBeenCalledOnce()
  })
})

describe('CLI freeze rating compatibility', () => {
  it('freezes a rating returned inside EXIF', async () => {
    process.argv = [process.execPath, 'cli.js', 'freeze', 'manual5']
    mocks.client.request.mockResolvedValue({ exifInfo: { rating: 5 } })
    await runCli()
    expect(exit).toHaveBeenCalledWith(0)
    expect(mocks.state.freeze).toHaveBeenCalledWith('manual5', 5)
  })
})
