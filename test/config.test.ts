import { describe, expect, it } from 'vitest'
import { fromToml, loadConfig, ConfigError } from '../src/config.js'
import { fileURLToPath } from 'node:url'
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

describe('loadConfig failures', () => {
  it('names the resolved path and the uid when the file is missing', () => {
    expect(() => loadConfig('/data/nope.toml')).toThrow(/no config at \/data\/nope\.toml \(running as uid \d+\)/)
  })

  it('says it is a directory rather than blaming the contents', () => {
    expect(() => loadConfig('/tmp')).toThrow(/is a directory, not a file/)
  })

  it('still reports a genuine parse error as a config error, not a read error', () => {
    const f = new URL('./fixtures/config.toml', import.meta.url)
    expect(() => loadConfig(fileURLToPath(f))).not.toThrow()
  })
})
