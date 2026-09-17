import type { Asset, Config } from '../../src/types.js'
import { fromToml } from '../../src/config.js'
import { readFileSync } from 'node:fs'

export function asset(over: Partial<Asset> & { id: string }): Asset {
  return {
    type: 'IMAGE',
    visibility: 'timeline',
    isTrashed: false,
    isArchived: false,
    isFavorite: false,
    rating: null,
    localDateTime: '2024-06-01T10:00:00.000Z',
    originalFileName: 'IMG_0001.jpg',
    width: 4032,
    height: 3024,
    stack: null,
    people: [],
    exifInfo: { make: 'Apple', model: 'iPhone 13', latitude: 45.18, longitude: 5.72 },
    ...over,
  }
}

/** Search response page as `POST /search/metadata` shapes it in Immich 3.2.0. */
export function searchPage(items: Asset[], nextCursor: string | null = null) {
  return {
    albums: { count: 0, facets: [], items: [], total: 0 },
    assets: { count: items.length, facets: [], items, nextCursor, nextPage: null, total: items.length },
  }
}

export const testConfig: Config = fromToml(readFileSync(new URL('./config.toml', import.meta.url), 'utf8'))
