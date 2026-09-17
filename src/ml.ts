import { normalise, parseVector } from './db.js'

export class MlError extends Error {}

export interface TextEmbedder {
  embed(text: string): Promise<Float64Array>
}

/**
 * immich-machine-learning `POST /predict`. Multipart, `entries` is a JSON string and the CLIP
 * output comes back JSON encoded a second time, unnormalised. See docs/immich-contract.md.
 */
export class MlClient implements TextEmbedder {
  constructor(
    private readonly baseUrl: string,
    private readonly modelName: string,
    private readonly doFetch: typeof fetch = fetch,
  ) {}

  async ping(): Promise<void> {
    const res = await this.doFetch(`${this.baseUrl}/ping`)
    if (!res.ok) throw new MlError(`ml container ping failed with ${res.status}`)
  }

  async embed(text: string): Promise<Float64Array> {
    const entries = JSON.stringify({ clip: { textual: { modelName: this.modelName } } })
    const form = new FormData()
    form.append('entries', entries)
    form.append('text', text)

    const res = await this.doFetch(`${this.baseUrl}/predict`, { method: 'POST', body: form })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new MlError(`predict failed with ${res.status}: ${body.slice(0, 300)}`)
    }
    return normalise(parseClipOutput(await res.json()))
  }
}

/** The `clip` value is a JSON string holding the array, not an array. Both shapes are accepted. */
export function parseClipOutput(payload: unknown): Float64Array {
  if (typeof payload !== 'object' || payload === null || !('clip' in payload)) {
    throw new MlError('predict response carries no clip output')
  }
  const clip = (payload as { clip: unknown }).clip
  if (typeof clip === 'string') {
    const trimmed = clip.trim()
    if (trimmed.startsWith('[')) return toFloat64(JSON.parse(trimmed))
    return parseVector(trimmed)
  }
  return toFloat64(clip)
}

function toFloat64(v: unknown): Float64Array {
  if (!Array.isArray(v) || v.length === 0) throw new MlError('clip output is not a non-empty array')
  const out = new Float64Array(v.length)
  for (let i = 0; i < v.length; i++) {
    const n = v[i]
    // Number(null) is 0, so a null component has to be rejected before coercion, not after.
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      throw new MlError(`clip output has a non-finite component at ${i}`)
    }
    out[i] = n
  }
  return out
}

/** Embeds every prompt once per run, in order: positives first, then negatives. */
export async function embedPrompts(
  embedder: TextEmbedder,
  positive: string[],
  negative: string[],
): Promise<{ vectors: Float64Array[]; positiveCount: number }> {
  const vectors: Float64Array[] = []
  for (const p of [...positive, ...negative]) vectors.push(await embedder.embed(p))
  const width = vectors[0]?.length ?? 0
  for (const v of vectors) {
    if (v.length !== width) throw new MlError('prompt embeddings came back with mixed widths')
  }
  return { vectors, positiveCount: positive.length }
}
