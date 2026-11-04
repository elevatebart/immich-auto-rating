import { describe, expect, it, vi } from 'vitest'
import { prepare } from '../src/run.js'
import { ImmichClient } from '../src/immich.js'
import { State } from '../src/state.js'
import { asset, searchPage, testConfig } from './fixtures/assets.js'
import type { Asset } from '../src/types.js'

const config = {
  ...testConfig,
  albums: { tripPatterns: [] },
  household: { persons: [] },
  ml: { modelName: 'test-model' },
}

async function prepareAssets(assets: Asset[], state: State) {
  const fetchImpl = vi.fn(async (url: string) => new Response(JSON.stringify(
    url.includes('/people') ? { people: [] } : searchPage(assets),
  )))
  const client = new ImmichClient('http://immich', 'key', { fetchImpl: fetchImpl as never })
  const store = {
    fetch: async () => new Map(assets.map((a) => [a.id, new Float64Array([1, 0])])),
    dimension: () => 2,
    close: async () => {},
  }
  return prepare(config, client, state, store)
}

describe('EXIF rating correction sync', () => {
  it('imports manual stars and rejections from Immich 3.3 responses', async () => {
    const state = new State(':memory:')
    try {
      const result = await prepareAssets([
        asset({ id: 'manual', rating: undefined, exifInfo: { rating: 5 } }),
        asset({ id: 'rejected', rating: undefined, exifInfo: { rating: -1 } }),
      ], state)
      expect(result.corrections.imported).toBe(2)
      expect(state.get('manual')).toMatchObject({ frozen: true, label: 5 })
      expect(state.get('rejected')).toMatchObject({ frozen: true, label: 1 })
      expect(result.labelled).toHaveLength(2)
    } finally {
      state.close()
    }
  })

  it('detects manual corrections and clears without resetting unchanged EXIF ratings', async () => {
    const state = new State(':memory:')
    try {
      state.recordWrite('unchanged', 4, 'zero-shot')
      state.recordWrite('corrected', 3, 'zero-shot')
      state.freeze('cleared', 5)
      const result = await prepareAssets([
        asset({ id: 'unchanged', rating: undefined, exifInfo: { rating: 4 } }),
        asset({ id: 'corrected', rating: undefined, exifInfo: { rating: 5 } }),
        asset({ id: 'cleared', rating: undefined, exifInfo: { rating: null } }),
      ], state)
      expect(result.corrections).toMatchObject({ frozen: 1, reset: 1, imported: 0 })
      expect(state.get('unchanged')).toMatchObject({ ratingWritten: 4, frozen: false })
      expect(state.get('corrected')).toMatchObject({ frozen: true, label: 5 })
      expect(state.get('cleared')).toMatchObject({ ratingWritten: null, frozen: false })
    } finally {
      state.close()
    }
  })
})
