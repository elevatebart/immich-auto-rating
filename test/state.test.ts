import { describe, expect, it } from 'vitest'
import { State, classify, toLabel } from '../src/state.js'
import type { StateRow } from '../src/types.js'

const row = (over: Partial<StateRow> = {}): StateRow => ({
  assetId: 'a',
  ratingWritten: null,
  ratedAt: null,
  frozen: false,
  label: null,
  modelVersion: null,
  ...over,
})

describe('toLabel', () => {
  it('maps a hand rejection to the strongest negative label', () => {
    expect(toLabel(-1)).toBe(1)
  })

  it('clamps into 1..5', () => {
    expect(toLabel(1)).toBe(1)
    expect(toLabel(5)).toBe(5)
    expect(toLabel(9)).toBe(5)
  })
})

describe('first run label import', () => {
  it('takes a pre-existing rating as a label instead of overwriting it', () => {
    expect(classify(undefined, 5)).toEqual({ kind: 'import', label: 5 })
    expect(classify(undefined, 1)).toEqual({ kind: 'import', label: 1 })
  })

  it('imports a hand rejection as a 1', () => {
    expect(classify(undefined, -1)).toEqual({ kind: 'import', label: 1 })
  })

  it('leaves an unrated asset alone', () => {
    expect(classify(undefined, null)).toEqual({ kind: 'none' })
  })
})

describe('correction detection', () => {
  it('does nothing when the rating still matches what we wrote', () => {
    expect(classify(row({ ratingWritten: 3 }), 3)).toEqual({ kind: 'none' })
  })

  it('freezes when the user changed the rating we wrote', () => {
    expect(classify(row({ ratingWritten: 3 }), 5)).toEqual({ kind: 'freeze', label: 5 })
  })

  it('freezes on a hand rejection of a rating we wrote', () => {
    expect(classify(row({ ratingWritten: 4 }), -1)).toEqual({ kind: 'freeze', label: 1 })
  })

  it('keeps a frozen asset frozen and silent when it has not moved', () => {
    expect(classify(row({ frozen: true, label: 5, ratingWritten: 5 }), 5)).toEqual({ kind: 'none' })
  })

  it('relabels when the user corrects an already frozen asset again', () => {
    expect(classify(row({ frozen: true, label: 5, ratingWritten: 5 }), 2)).toEqual({
      kind: 'relabel',
      label: 2,
    })
  })

  it('treats a cleared rating as a request to rate it again', () => {
    expect(classify(row({ ratingWritten: 4 }), null)).toEqual({ kind: 'reset' })
    expect(classify(row({ frozen: true, label: 5, ratingWritten: 5 }), null)).toEqual({ kind: 'reset' })
  })

  it('stays quiet on an asset we have never written and nobody rated', () => {
    expect(classify(row(), null)).toEqual({ kind: 'none' })
  })
})

describe('State', () => {
  const open = () => new State(':memory:')

  it('records a write and reads it back', () => {
    const s = open()
    s.recordWrite('a', 4, 'zero-shot')
    expect(s.get('a')).toMatchObject({ assetId: 'a', ratingWritten: 4, frozen: false, modelVersion: 'zero-shot' })
    s.close()
  })

  it('never overwrites a frozen asset', () => {
    const s = open()
    s.freeze('a', 5)
    s.recordWrite('a', 2, 'ridge')
    expect(s.get('a')).toMatchObject({ frozen: true, label: 5 })
    s.close()
  })

  it('exposes frozen labels for training', () => {
    const s = open()
    s.freeze('a', 5)
    s.freeze('b', 1)
    s.recordWrite('c', 3, 'ridge')
    expect(s.labels().sort((x, y) => x.assetId.localeCompare(y.assetId))).toEqual([
      { assetId: 'a', label: 5 },
      { assetId: 'b', label: 1 },
    ])
    expect(s.frozenIds()).toEqual(new Set(['a', 'b']))
    s.close()
  })

  it('applies a reset back to unrated', () => {
    const s = open()
    s.recordWrite('a', 4, 'zero-shot')
    s.apply('a', null, { kind: 'reset' })
    expect(s.get('a')).toMatchObject({ ratingWritten: null, frozen: false, label: null })
    s.close()
  })

  it('tracks the first run flag', () => {
    const s = open()
    expect(s.isFirstRun()).toBe(true)
    s.markFirstRunDone()
    expect(s.isFirstRun()).toBe(false)
    s.close()
  })
})
