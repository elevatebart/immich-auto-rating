import { describe, expect, it } from 'vitest'
import { fromToml, ConfigError } from '../src/config.js'
import { testConfig } from './fixtures/assets.js'

describe('config', () => {
  it('reads the example config', () => {
    expect(testConfig.pool.album).toBe('Wallpaper pool')
    expect(testConfig.pool.minRating).toBe(4)
    expect(testConfig.zeroshot.quantiles).toHaveLength(4)
    expect(testConfig.prompts.negative.length).toBeGreaterThan(0)
  })

  it('lower cases filename patterns so matching is case insensitive', () => {
    const cfg = fromToml(`
[prompts]
positive = ["a"]
negative = ["b"]
[exif]
filename_patterns = ["Screenshot", "SCAN_"]
`)
    expect(cfg.exif.filenamePatterns).toEqual(['screenshot', 'scan_'])
  })

  it('refuses a rating outside 1..5 for the pool', () => {
    const toml = `
[prompts]
positive = ["a"]
negative = ["b"]
[pool]
min_rating = 6
`
    expect(() => fromToml(toml)).toThrow(ConfigError)
  })

  it('refuses quantiles that do not increase', () => {
    const toml = `
[prompts]
positive = ["a"]
negative = ["b"]
[zeroshot]
quantiles = [0.4, 0.4, 0.7, 0.9]
`
    expect(() => fromToml(toml)).toThrow(/increase/)
  })

  it('requires both prompt lists', () => {
    expect(() => fromToml('[prompts]\npositive = ["a"]\n')).toThrow(/negative is required/)
  })
})
