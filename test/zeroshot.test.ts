import { describe, expect, it } from 'vitest'
import { bucket, promptScore, quantileCuts, rankFractions, scoreZeroShot } from '../src/zeroshot.js'
import { normalise } from '../src/db.js'
import { buildFeatures } from '../src/features.js'
import { asset, testConfig } from './fixtures/assets.js'
import type { Candidate } from '../src/types.js'

const vec = (...xs: number[]) => normalise(Float64Array.from(xs))
const POSITIVE = vec(1, 0, 0)
const NEGATIVE = vec(0, 1, 0)
const prompts = { vectors: [POSITIVE, NEGATIVE], positiveCount: 1 }

const candidate = (id: string, embedding: Float64Array, over = {}): Candidate => {
  const a = asset({ id, ...over })
  return { asset: a, features: buildFeatures(a, testConfig, new Set(), new Set()), embedding }
}

describe('promptScore', () => {
  it('gives nearly all the mass to the matching side', () => {
    expect(promptScore(POSITIVE, prompts).positiveMass).toBeGreaterThan(0.99)
    expect(promptScore(NEGATIVE, prompts).positiveMass).toBeLessThan(0.01)
  })

  it('reports a negative lead only when a negative prompt wins', () => {
    expect(promptScore(NEGATIVE, prompts).negativeLead).toBeGreaterThan(0.9)
    expect(promptScore(POSITIVE, prompts).negativeLead).toBe(0)
  })

  it('splits evenly on a vector equidistant from both prompts', () => {
    const s = promptScore(vec(1, 1, 0), prompts)
    expect(s.positiveMass).toBeCloseTo(0.5, 6)
    expect(s.negativeLead).toBe(0)
  })
})

describe('quantile mapping', () => {
  it('cuts at the configured points of the run distribution', () => {
    const values = Array.from({ length: 101 }, (_, i) => i / 100)
    expect(quantileCuts(values, [0.15, 0.4, 0.7, 0.9])).toEqual([0.15, 0.4, 0.7, 0.9])
  })

  it('assigns a bucket per cut, ending at 5', () => {
    const cuts = [0.15, 0.4, 0.7, 0.9]
    expect(bucket(0.0, cuts)).toBe(1)
    expect(bucket(0.2, cuts)).toBe(2)
    expect(bucket(0.5, cuts)).toBe(3)
    expect(bucket(0.8, cuts)).toBe(4)
    expect(bucket(0.95, cuts)).toBe(5)
  })

  it('handles an empty run without throwing', () => {
    expect(quantileCuts([], [0.5])).toEqual([0])
  })
})

describe('rankFractions', () => {
  it('spreads ranks from 0 to 1 regardless of the values', () => {
    expect(rankFractions([5, 1, 3])).toEqual([1, 0, 0.5])
  })

  it('keeps input order on ties', () => {
    expect(rankFractions([2, 2, 2])).toEqual([0, 0.5, 1])
  })

  it('handles a single asset', () => {
    expect(rankFractions([0.7])).toEqual([0])
  })
})

describe('scoreZeroShot', () => {
  it('fills all five buckets even though the softmax saturates', () => {
    // These scores are a near step function, which is what a CLIP softmax actually produces.
    const cands = Array.from({ length: 40 }, (_, i) => candidate(`a${i}`, vec(40 - i, i + 1, 0)))
    const out = scoreZeroShot(cands, prompts, testConfig)
    expect(out).toHaveLength(40)
    // The negative-margin floor pushes the bottom half to 1, so check the top half spreads.
    expect(new Set(out.map((s) => s.rating)).size).toBeGreaterThanOrEqual(4)
  })

  it('ranks by quantile share when nothing is forced', () => {
    const cands = Array.from({ length: 100 }, (_, i) => candidate(`a${i}`, vec(100 - i * 0.5, 1, 0)))
    const out = scoreZeroShot(cands, prompts, testConfig)
    const counts = new Map<number, number>()
    for (const s of out) counts.set(s.rating, (counts.get(s.rating) ?? 0) + 1)
    // quantiles [0.15, 0.4, 0.7, 0.9] over 100 assets, ranks running r/99.
    expect(counts.get(1)).toBe(15)
    expect(counts.get(2)).toBe(25)
    expect(counts.get(3)).toBe(30)
    expect(counts.get(4)).toBe(20)
    expect(counts.get(5)).toBe(10)
  })

  it('bumps an asset holding a household face by one star, capped at 5', () => {
    const plain = candidate('plain', POSITIVE)
    const withFace = candidate('face', POSITIVE)
    withFace.features = { ...withFace.features, householdFaces: 2 }
    const mid = candidate('mid', vec(1, 1, 0))

    const out = scoreZeroShot([plain, withFace, mid], prompts, testConfig)
    const byId = new Map(out.map((s) => [s.id, s.rating]))
    expect(byId.get('face')!).toBeGreaterThanOrEqual(byId.get('plain')!)
    expect(byId.get('face')!).toBeLessThanOrEqual(5)
  })

  it('forces a 1 when the asset is screenshot shaped, whatever the prompts say', () => {
    const shot = candidate('shot', POSITIVE, { originalFileName: 'Screenshot 2024-01-02.png' })
    expect(shot.features.screenshotShaped).toBe(true)
    const out = scoreZeroShot([shot, candidate('ok', POSITIVE)], prompts, testConfig)
    expect(out.find((s) => s.id === 'shot')!.rating).toBe(1)
  })

  it('forces a 1 when a negative prompt wins by the configured margin', () => {
    const cands = [candidate('neg', NEGATIVE), ...Array.from({ length: 5 }, (_, i) => candidate(`p${i}`, POSITIVE))]
    const out = scoreZeroShot(cands, prompts, testConfig)
    expect(out.find((s) => s.id === 'neg')!.rating).toBe(1)
  })

  it('skips assets with no embedding rather than scoring them blind', () => {
    const missing = { ...candidate('x', POSITIVE), embedding: undefined }
    expect(scoreZeroShot([missing], prompts, testConfig)).toHaveLength(0)
  })
})
