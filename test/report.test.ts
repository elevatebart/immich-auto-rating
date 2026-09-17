import { describe, expect, it } from 'vitest'
import { assetUrl, buildReport, formatReport } from '../src/report.js'
import type { Scored } from '../src/types.js'

const s = (id: string, rating: number, uncertainty: number): Scored =>
  ({ id, rating, uncertainty, raw: rating, reason: 'ridge' }) as Scored

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

describe('assetUrl', () => {
  it('builds the Immich web link and tolerates a trailing slash', () => {
    expect(assetUrl('http://immich/', 'abc')).toBe('http://immich/photos/abc')
  })
})
