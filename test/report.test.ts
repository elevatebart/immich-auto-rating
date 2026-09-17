import { describe, expect, it } from 'vitest'
import { assetUrl, buildReport, formatReport } from '../src/report.js'
import type { Scored } from '../src/types.js'

const s = (id: string, rating: number, uncertainty: number, rule?: string): Scored =>
  ({ id, rating, uncertainty, raw: rating, reason: 'ridge', rule }) as Scored

describe('buildReport', () => {
  it('counts every bucket, including the empty ones', () => {
    const report = buildReport([s('a', 5, 0.4), s('b', 5, 0.3), s('c', 1, 0.5)], 'http://immich')
    expect(report.counts).toEqual({ '1': 1, '2': 0, '3': 0, '4': 0, '5': 2 })
    expect(report.total).toBe(3)
  })

  it('puts the least certain first and links them for correction', () => {
    const report = buildReport([s('a', 4, 0.45), s('b', 3, 0.02), s('c', 2, 0.3)], 'http://immich')
    expect(report.uncertain.map((u) => u.id)).toEqual(['b', 'c', 'a'])
    expect(report.uncertain[0]!.url).toBe('http://immich/photos/b')
  })

  it('caps the list at the requested size', () => {
    const scored = Array.from({ length: 100 }, (_, i) => s(`a${i}`, 3, i / 100))
    expect(buildReport(scored, 'http://immich', 30).uncertain).toHaveLength(30)
    expect(buildReport(scored, 'http://immich', 5).uncertain).toHaveLength(5)
  })

  it('survives an empty run', () => {
    const report = buildReport([], 'http://immich')
    expect(report.total).toBe(0)
    expect(report.uncertain).toEqual([])
    expect(formatReport(report, 'ridge')).toContain('rated: 0')
  })
})

describe('report diagnostics', () => {
  it('counts the pool against the configured threshold', () => {
    const scored = [s('a', 5, 0.4), s('b', 4, 0.4), s('c', 3, 0.4), s('d', 1, 0.4)]
    expect(buildReport(scored, 'http://i', 30, 4).poolSize).toBe(2)
    expect(buildReport(scored, 'http://i', 30, 5).poolSize).toBe(1)
  })

  it('breaks down which rule settled each rating', () => {
    const scored = [
      s('a', 1, 0.5, 'screenshot'),
      s('b', 1, 0.1, 'negative-prompt'),
      s('c', 5, 0.4, 'household-bump'),
      s('d', 3, 0.4, 'quantile'),
      s('e', 1, 0.5, 'screenshot'),
    ]
    expect(buildReport(scored, 'http://i').rules).toEqual({
      screenshot: 2,
      'negative-prompt': 1,
      'household-bump': 1,
      quantile: 1,
    })
  })

  it('shows the pool share and the rule breakdown in the text form', () => {
    const out = formatReport(buildReport([s('a', 5, 0.4, 'quantile')], 'http://i', 30, 4), 'zero-shot')
    expect(out).toContain('pool at >= 4 star: 1 assets')
    expect(out).toContain('quantile')
  })
})

describe('assetUrl', () => {
  it('builds the Immich web link and tolerates a trailing slash', () => {
    expect(assetUrl('http://immich/', 'abc')).toBe('http://immich/photos/abc')
  })
})
