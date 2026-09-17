import { describe, expect, it } from 'vitest'
import { clampRating, designRow, fit, kFoldMae, predict, scoreRidge, trainModel, uncertainty } from '../src/ridge.js'
import { buildFeatures } from '../src/features.js'
import { asset, testConfig } from './fixtures/assets.js'
import type { Candidate } from '../src/types.js'

const candidate = (id: string, embedding: number[], over = {}): Candidate => {
  const a = asset({ id, ...over })
  return {
    asset: a,
    features: buildFeatures(a, testConfig, new Set(), new Set()),
    embedding: Float64Array.from(embedding),
  }
}

describe('designRow', () => {
  it('lays out embedding, then features, then the bias', () => {
    const c = candidate('a', [0.1, 0.2])
    const row = designRow(c)
    expect(row).toHaveLength(2 + 7 + 1)
    expect(row[0]).toBeCloseTo(0.1)
    expect(row[1]).toBeCloseTo(0.2)
    expect(row[row.length - 1]).toBe(1)
  })

  it('refuses an asset with no embedding', () => {
    expect(() => designRow({ ...candidate('a', [0.1]), embedding: undefined })).toThrow(/no embedding/)
  })
})

describe('fit', () => {
  it('recovers a clean linear relation on a toy set', () => {
    // y = 2*x0 + 3*x1 + 1, with the bias column last.
    const rows = [
      [1, 0, 1],
      [0, 1, 1],
      [1, 1, 1],
      [2, 1, 1],
      [1, 2, 1],
      [3, 2, 1],
    ].map((r) => Float64Array.from(r))
    const targets = rows.map((r) => 2 * r[0]! + 3 * r[1]! + 1)

    const w = fit(rows, targets, 1e-6)
    expect(w[0]).toBeCloseTo(2, 3)
    expect(w[1]).toBeCloseTo(3, 3)
    expect(w[2]).toBeCloseTo(1, 3)
  })

  it('shrinks the weights as lambda grows', () => {
    const rows = [
      [1, 0, 1],
      [0, 1, 1],
      [1, 1, 1],
    ].map((r) => Float64Array.from(r))
    const targets = [3, 4, 7]

    const loose = fit(rows, targets, 1e-6)
    const tight = fit(rows, targets, 100)
    expect(Math.abs(tight[0]!)).toBeLessThan(Math.abs(loose[0]!))
  })

  it('stays solvable when columns are perfectly collinear', () => {
    const rows = [
      [1, 1, 1],
      [2, 2, 1],
      [3, 3, 1],
    ].map((r) => Float64Array.from(r))
    expect(() => fit(rows, [2, 4, 6], 1)).not.toThrow()
  })

  it('refuses mismatched rows and targets', () => {
    expect(() => fit([Float64Array.from([1, 1])], [1, 2], 1)).toThrow(/differ in length/)
  })
})

describe('trainModel and scoreRidge', () => {
  it('learns that one embedding direction means a good photo', () => {
    const labelled = [
      { candidate: candidate('a', [1, 0]), label: 5 },
      { candidate: candidate('b', [0.9, 0.1]), label: 5 },
      { candidate: candidate('c', [0.8, 0.2]), label: 4 },
      { candidate: candidate('d', [0.2, 0.8]), label: 2 },
      { candidate: candidate('e', [0.1, 0.9]), label: 1 },
      { candidate: candidate('f', [0, 1]), label: 1 },
    ]
    const model = trainModel(labelled, 0.01, 'test')
    expect(model.embeddingDim).toBe(2)

    const out = scoreRidge(model, [candidate('good', [0.95, 0.05]), candidate('bad', [0.05, 0.95])])
    const byId = new Map(out.map((s) => [s.id, s.rating]))
    expect(byId.get('good')!).toBeGreaterThan(byId.get('bad')!)
    expect(out.every((s) => s.rating >= 1 && s.rating <= 5)).toBe(true)
    expect(out.every((s) => s.reason === 'ridge')).toBe(true)
  })

  it('skips assets with no embedding', () => {
    const model = trainModel([{ candidate: candidate('a', [1, 0]), label: 5 }], 1, 'test')
    expect(scoreRidge(model, [{ ...candidate('x', [1, 0]), embedding: undefined }])).toHaveLength(0)
  })

  it('refuses to predict across a different embedding width', () => {
    const model = trainModel([{ candidate: candidate('a', [1, 0]), label: 5 }], 1, 'test')
    expect(() => predict(model.weights, designRow(candidate('b', [1, 0, 0])))).toThrow(/expects/)
  })
})

describe('clamp and uncertainty', () => {
  it('rounds and clamps into 1..5, never 0 and never -1', () => {
    expect(clampRating(-4)).toBe(1)
    expect(clampRating(0.2)).toBe(1)
    expect(clampRating(3.4)).toBe(3)
    expect(clampRating(3.6)).toBe(4)
    expect(clampRating(99)).toBe(5)
  })

  it('reports 0 on a half-star boundary and 0.5 dead centre of a bucket', () => {
    expect(uncertainty(3.5)).toBeCloseTo(0.5, 6)
    expect(uncertainty(3.0)).toBeCloseTo(0, 6)
    expect(uncertainty(2.9)).toBeCloseTo(0.1, 6)
    expect(uncertainty(7)).toBeCloseTo(0, 6)
  })
})

describe('kFoldMae', () => {
  it('reports a low error on a set the model can learn', () => {
    const labelled = Array.from({ length: 20 }, (_, i) => {
      const t = i / 19
      return { candidate: candidate(`a${i}`, [1 - t, t]), label: Math.round(1 + 4 * (1 - t)) }
    })
    const out = kFoldMae(labelled, 0.01, 5)
    expect(out.n).toBe(20)
    expect(out.folds).toBe(5)
    expect(out.mae).toBeLessThan(1)
  })

  it('refuses to cross validate a single label', () => {
    expect(() => kFoldMae([{ candidate: candidate('a', [1, 0]), label: 5 }], 1, 5)).toThrow(/at least 2/)
  })
})
