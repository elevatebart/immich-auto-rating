import { describe, expect, it, vi } from 'vitest'
import { MlClient, embedPrompts, parseClipOutput } from '../src/ml.js'
import { cosine, normalise, parseVector } from '../src/db.js'

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

describe('parseClipOutput', () => {
  it('unwraps the JSON string the container actually returns', () => {
    const out = parseClipOutput({ clip: '[0.1,0.2,-0.3]' })
    expect(Array.from(out)).toEqual([0.1, 0.2, -0.3])
  })

  it('also accepts a plain array, in case a later version stops double encoding', () => {
    expect(Array.from(parseClipOutput({ clip: [1, 2] }))).toEqual([1, 2])
  })

  it('refuses a response with no clip key', () => {
    expect(() => parseClipOutput({ ocr: 'x' })).toThrow(/no clip output/)
    expect(() => parseClipOutput(null)).toThrow(/no clip output/)
  })

  it('refuses a non-finite component rather than poisoning the model', () => {
    expect(() => parseClipOutput({ clip: '[0.1,null]' })).toThrow(/non-finite/)
  })

  it('refuses an empty array', () => {
    expect(() => parseClipOutput({ clip: '[]' })).toThrow(/non-empty/)
  })
})

describe('MlClient', () => {
  it('posts multipart with entries as a JSON string and the text field', async () => {
    const doFetch = vi.fn(async (_url: string, _init: RequestInit) => ok({ clip: '[3,4]' }))
    const client = new MlClient('http://ml:3003', 'ViT-B-32__openai', doFetch as never)
    await client.embed('a photo of a receipt')

    const [url, init] = doFetch.mock.calls[0]! as [string, RequestInit]
    expect(url).toBe('http://ml:3003/predict')
    expect(init.method).toBe('POST')
    const form = init.body as FormData
    expect(JSON.parse(form.get('entries') as string)).toEqual({
      clip: { textual: { modelName: 'ViT-B-32__openai' } },
    })
    expect(form.get('text')).toBe('a photo of a receipt')
    expect(form.get('image')).toBeNull()
  })

  it('L2-normalises, because the container returns the raw ONNX output', async () => {
    const doFetch = vi.fn(async (_url: string, _init: RequestInit) => ok({ clip: '[3,4]' }))
    const client = new MlClient('http://ml:3003', 'ViT-B-32__openai', doFetch as never)
    const v = await client.embed('x')
    expect(Array.from(v)).toEqual([0.6, 0.8])
  })

  it('surfaces the container status on a failure', async () => {
    const doFetch = vi.fn(async () => new Response('no such model', { status: 500 }))
    const client = new MlClient('http://ml:3003', 'bad', doFetch as never)
    await expect(client.embed('x')).rejects.toThrow(/500/)
  })
})

describe('embedPrompts', () => {
  it('embeds positives then negatives, in order, once each', async () => {
    const seen: string[] = []
    const embedder = {
      embed: async (t: string) => {
        seen.push(t)
        return Float64Array.from([1, 0])
      },
    }
    const out = await embedPrompts(embedder, ['p1', 'p2'], ['n1'])
    expect(seen).toEqual(['p1', 'p2', 'n1'])
    expect(out.positiveCount).toBe(2)
    expect(out.vectors).toHaveLength(3)
  })

  it('refuses prompt embeddings of mixed widths', async () => {
    let n = 0
    const embedder = { embed: async () => Float64Array.from(n++ === 0 ? [1, 0] : [1, 0, 0]) }
    await expect(embedPrompts(embedder, ['a'], ['b'])).rejects.toThrow(/mixed widths/)
  })
})

describe('vector helpers', () => {
  it('parses the pgvector text literal', () => {
    expect(Array.from(parseVector('[0.5,-0.25,1]'))).toEqual([0.5, -0.25, 1])
  })

  it('refuses anything that is not a pgvector literal', () => {
    expect(() => parseVector('0.5,0.25')).toThrow(/not a pgvector literal/)
  })

  it('normalises to unit length and leaves a zero vector alone', () => {
    expect(Array.from(normalise(Float64Array.from([3, 4])))).toEqual([0.6, 0.8])
    expect(Array.from(normalise(Float64Array.from([0, 0])))).toEqual([0, 0])
  })

  it('computes cosine on unit vectors and refuses mismatched widths', () => {
    expect(cosine(Float64Array.from([1, 0]), Float64Array.from([1, 0]))).toBeCloseTo(1)
    expect(cosine(Float64Array.from([1, 0]), Float64Array.from([0, 1]))).toBeCloseTo(0)
    expect(() => cosine(Float64Array.from([1]), Float64Array.from([1, 0]))).toThrow(/cosine over/)
  })
})
