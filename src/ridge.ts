import { featureVector } from './features.js'
import type { Candidate, Rating, Scored } from './types.js'

export class RidgeError extends Error {}

export interface RidgeModel {
  weights: Float64Array
  /** Width of the embedding block, so a later run can refuse a model from a different CLIP space. */
  embeddingDim: number
  version: string
}

/** [embedding, engineered features, bias]. The bias is last and is never penalised. */
export function designRow(c: Candidate): Float64Array {
  if (!c.embedding) throw new RidgeError(`asset ${c.asset.id} has no embedding`)
  const feats = featureVector(c.features)
  const row = new Float64Array(c.embedding.length + feats.length + 1)
  row.set(c.embedding, 0)
  row.set(feats, c.embedding.length)
  row[row.length - 1] = 1
  return row
}

export function fit(rows: Float64Array[], targets: number[], lambda: number): Float64Array {
  if (rows.length === 0) throw new RidgeError('cannot fit on zero rows')
  if (rows.length !== targets.length) throw new RidgeError('rows and targets differ in length')
  const d = rows[0]!.length

  // Normal equations. Gram is symmetric, so only the lower triangle is accumulated.
  const gram = new Float64Array(d * d)
  const rhs = new Float64Array(d)
  for (let n = 0; n < rows.length; n++) {
    const x = rows[n]!
    const y = targets[n]!
    for (let i = 0; i < d; i++) {
      const xi = x[i]!
      if (xi === 0) continue
      rhs[i]! += xi * y
      for (let j = 0; j <= i; j++) gram[i * d + j]! += xi * x[j]!
    }
  }
  for (let i = 0; i < d; i++) for (let j = 0; j < i; j++) gram[j * d + i] = gram[i * d + j]!
  for (let i = 0; i < d - 1; i++) gram[i * d + i]! += lambda

  return solveSpd(gram, rhs, d)
}

/** Cholesky with a jitter retry, which is cheaper than a full pivoted solve at this size. */
function solveSpd(a: Float64Array, b: Float64Array, d: number): Float64Array {
  for (let attempt = 0; attempt < 4; attempt++) {
    const m = Float64Array.from(a)
    if (attempt > 0) {
      const jitter = 10 ** (-8 + attempt)
      for (let i = 0; i < d; i++) m[i * d + i]! += jitter
    }
    const l = cholesky(m, d)
    if (l) return backSolve(l, b, d)
  }
  throw new RidgeError('gram matrix is not positive definite, raise ridge.lambda')
}

function cholesky(m: Float64Array, d: number): Float64Array | null {
  const l = new Float64Array(d * d)
  for (let i = 0; i < d; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = m[i * d + j]!
      for (let k = 0; k < j; k++) sum -= l[i * d + k]! * l[j * d + k]!
      if (i === j) {
        if (sum <= 0) return null
        l[i * d + j] = Math.sqrt(sum)
      } else {
        l[i * d + j] = sum / l[j * d + j]!
      }
    }
  }
  return l
}

function backSolve(l: Float64Array, b: Float64Array, d: number): Float64Array {
  const y = new Float64Array(d)
  for (let i = 0; i < d; i++) {
    let sum = b[i]!
    for (let k = 0; k < i; k++) sum -= l[i * d + k]! * y[k]!
    y[i] = sum / l[i * d + i]!
  }
  const x = new Float64Array(d)
  for (let i = d - 1; i >= 0; i--) {
    let sum = y[i]!
    for (let k = i + 1; k < d; k++) sum -= l[k * d + i]! * x[k]!
    x[i] = sum / l[i * d + i]!
  }
  return x
}

export function predict(weights: Float64Array, row: Float64Array): number {
  if (weights.length !== row.length) {
    throw new RidgeError(`model expects ${weights.length} columns, got ${row.length}`)
  }
  let sum = 0
  for (let i = 0; i < row.length; i++) sum += weights[i]! * row[i]!
  return sum
}

export function clampRating(raw: number): Rating {
  return Math.min(5, Math.max(1, Math.round(raw))) as Rating
}

/** Distance to the nearest half-star boundary: 0 is a coin flip, 0.5 is dead centre of a bucket. */
export function uncertainty(raw: number): number {
  const clamped = Math.min(5, Math.max(1, raw))
  return Math.abs(clamped - Math.round(clamped))
}

export function trainModel(
  labelled: { candidate: Candidate; label: number }[],
  lambda: number,
  version: string,
): RidgeModel {
  const rows = labelled.map((l) => designRow(l.candidate))
  const weights = fit(
    rows,
    labelled.map((l) => l.label),
    lambda,
  )
  return { weights, embeddingDim: labelled[0]!.candidate.embedding!.length, version }
}

export function scoreRidge(model: RidgeModel, candidates: Candidate[]): Scored[] {
  return candidates
    .filter((c) => c.embedding)
    .map((c) => {
      const raw = predict(model.weights, designRow(c))
      return {
        id: c.asset.id,
        rating: clampRating(raw),
        raw,
        uncertainty: uncertainty(raw),
        reason: 'ridge' as const,
      }
    })
}

/** Mean absolute error over k folds, on the rounded and clamped prediction the CLI would write. */
export function kFoldMae(
  labelled: { candidate: Candidate; label: number }[],
  lambda: number,
  folds: number,
): { mae: number; folds: number; n: number } {
  const n = labelled.length
  const k = Math.min(folds, n)
  if (k < 2) throw new RidgeError(`need at least 2 labels to cross validate, have ${n}`)

  const rows = labelled.map((l) => designRow(l.candidate))
  const targets = labelled.map((l) => l.label)
  let total = 0
  for (let f = 0; f < k; f++) {
    const trainRows: Float64Array[] = []
    const trainY: number[] = []
    const testIdx: number[] = []
    for (let i = 0; i < n; i++) {
      if (i % k === f) testIdx.push(i)
      else {
        trainRows.push(rows[i]!)
        trainY.push(targets[i]!)
      }
    }
    if (trainRows.length === 0 || testIdx.length === 0) continue
    const w = fit(trainRows, trainY, lambda)
    for (const i of testIdx) total += Math.abs(clampRating(predict(w, rows[i]!)) - targets[i]!)
  }
  return { mae: total / n, folds: k, n }
}
