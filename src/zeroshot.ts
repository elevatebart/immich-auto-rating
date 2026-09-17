import { cosine } from './db.js'
import type { Candidate, Config, Rating, Scored } from './types.js'

export interface ZeroShotPrompts {
  vectors: Float64Array[]
  positiveCount: number
}

export interface PromptScore {
  positiveMass: number
  /** How far the best negative prompt beats the best positive one, 0 when it does not. */
  negativeLead: number
}

/**
 * Softmax over every prompt at once, so positives and negatives compete on one scale.
 * CLIP logits are cosines times 100, the usual scale for a CLIP zero-shot head.
 */
export function promptScore(embedding: Float64Array, prompts: ZeroShotPrompts): PromptScore {
  const logits = prompts.vectors.map((v) => cosine(embedding, v) * 100)
  const max = Math.max(...logits)
  const exps = logits.map((l) => Math.exp(l - max))
  const total = exps.reduce((a, b) => a + b, 0)
  const probs = exps.map((e) => e / total)

  let positiveMass = 0
  let bestPositive = -Infinity
  let bestNegative = -Infinity
  for (let i = 0; i < probs.length; i++) {
    const p = probs[i]!
    if (i < prompts.positiveCount) {
      positiveMass += p
      if (p > bestPositive) bestPositive = p
    } else if (p > bestNegative) bestNegative = p
  }
  return { positiveMass, negativeLead: Math.max(0, bestNegative - bestPositive) }
}

/** Cut points from the run's own distribution, so the buckets fill whatever the prompts score. */
export function quantileCuts(values: number[], quantiles: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 0) return quantiles.map(() => 0)
  return quantiles.map((q) => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))
    return sorted[idx]!
  })
}

export function bucket(value: number, cuts: number[]): Rating {
  let r = 1
  for (const cut of cuts) {
    if (value > cut) r++
  }
  return Math.min(5, r) as Rating
}

/** Rank of each value, 0 for the lowest and 1 for the highest. Ties keep their input order. */
export function rankFractions(values: number[]): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v || a.i - b.i)
  const out = new Array<number>(values.length)
  const last = Math.max(1, values.length - 1)
  for (let r = 0; r < order.length; r++) out[order[r]!.i] = r / last
  return out
}

/**
 * Cold start scoring. Buckets are taken on rank, not on the raw value: a CLIP softmax saturates
 * near 0 and 1, so value thresholds collapse into two buckets while ranks always fill all five.
 */
export function scoreZeroShot(
  candidates: Candidate[],
  prompts: ZeroShotPrompts,
  cfg: Config,
): Scored[] {
  const scored = candidates
    .filter((c) => c.embedding)
    .map((c) => ({ c, s: promptScore(c.embedding!, prompts) }))

  const ranks = rankFractions(scored.map((x) => x.s.positiveMass))

  return scored.map(({ c, s }, i) => {
    const rank = ranks[i]!
    let rating: Rating = bucket(rank, cfg.zeroshot.quantiles)
    if (c.features.householdFaces > 0) rating = Math.min(5, rating + 1) as Rating
    if (c.features.screenshotShaped || s.negativeLead >= cfg.zeroshot.negativeMargin) rating = 1

    return {
      id: c.asset.id,
      rating,
      raw: s.positiveMass,
      uncertainty: distanceToCut(rank, cfg.zeroshot.quantiles),
      reason: 'zero-shot' as const,
    }
  })
}

/** 0 sits on a bucket boundary, 0.5 sits as far from one as the cut points allow. */
function distanceToCut(rank: number, cuts: number[]): number {
  if (cuts.length === 0) return 0.5
  return Math.min(0.5, Math.min(...cuts.map((c) => Math.abs(rank - c))))
}
