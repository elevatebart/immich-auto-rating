import { describe, expect, it } from 'vitest'
import { buildFeatures, featureVector, resolveHousehold, screenshotArm, screenshotShaped } from '../src/features.js'
import { asset, testConfig } from './fixtures/assets.js'

// The shipped config leaves screenshot_ratios empty, which switches the ratio arm off. The arm is
// still code, so these give it ratios rather than testing it through a config that disables it.
const withRatios = {
  ...testConfig,
  exif: { ...testConfig.exif, screenshotRatios: [1.7777, 2.1666, 2.0, 1.6, 1.3333] },
}

describe('screenshotShaped', () => {
  it('trusts the file name whatever the EXIF says', () => {
    expect(screenshotShaped(asset({ id: 'a', originalFileName: 'Screenshot 2024.png' }), testConfig)).toBe(true)
    expect(screenshotShaped(asset({ id: 'b', originalFileName: 'SCAN_0004.pdf.jpg' }), testConfig)).toBe(true)
    expect(screenshotShaped(asset({ id: 'c', originalFileName: 'facture-edf.jpg' }), testConfig)).toBe(true)
  })

  it('does not call a 4:3 camera photo a screenshot', () => {
    const photo = asset({ id: 'p', width: 4032, height: 3024, exifInfo: { make: 'Apple' } })
    expect(screenshotShaped(photo, withRatios)).toBe(false)
  })

  it('does not call a 16:9 camera photo a screenshot', () => {
    const photo = asset({ id: 'p', width: 1920, height: 1080, exifInfo: { make: 'SONY' } })
    expect(screenshotShaped(photo, withRatios)).toBe(false)
  })

  it('catches a phone screenshot when ratios are configured', () => {
    const shot = asset({ id: 's', width: 1170, height: 2532, originalFileName: 'IMG_1.png', exifInfo: { make: null } })
    expect(screenshotShaped(shot, withRatios)).toBe(true)
  })

  it('is off when screenshot_ratios is empty, which is the shipped default', () => {
    const shot = asset({ id: 's', width: 1170, height: 2532, originalFileName: 'IMG_1.png', exifInfo: { make: null } })
    expect(testConfig.exif.screenshotRatios).toEqual([])
    expect(screenshotShaped(shot, testConfig)).toBe(false)
  })

  it('still catches an old camera photo when ratios are on, which is why they are off', () => {
    const oldPhoto = asset({ id: 'o', width: 4032, height: 3024, originalFileName: 'IMG_0983.JPG', exifInfo: { make: null } })
    expect(screenshotShaped(oldPhoto, withRatios)).toBe(true)
    expect(screenshotShaped(oldPhoto, testConfig)).toBe(false)
  })

  it('falls back to the EXIF dimensions when width and height are missing', () => {
    const shot = asset({
      id: 's',
      width: null,
      height: null,
      originalFileName: 'a.png',
      exifInfo: { make: null, exifImageWidth: 2560, exifImageHeight: 1440 },
    })
    expect(screenshotShaped(shot, withRatios)).toBe(true)
  })

  it('says no when there are no dimensions at all', () => {
    const unknown = asset({ id: 'u', width: null, height: null, originalFileName: 'a.png', exifInfo: {} })
    expect(screenshotShaped(unknown, testConfig)).toBe(false)
  })
})

describe('screenshotArm', () => {
  it('names the file name arm', () => {
    expect(screenshotArm(asset({ id: 'a', originalFileName: 'Screenshot 1.png' }), testConfig)).toBe('filename')
  })

  it('names the ratio arm, which only fires without a camera make', () => {
    const noMake = asset({ id: 'b', width: 1170, height: 2532, originalFileName: 'x.png', exifInfo: { make: null } })
    expect(screenshotArm(noMake, withRatios)).toBe('ratio')
  })

  it('is null for a camera photo at the same ratio', () => {
    expect(screenshotArm(asset({ id: 'c', width: 1920, height: 1080, exifInfo: { make: 'SONY' } }), testConfig)).toBeNull()
  })

  it('prefers the file name when both would fire', () => {
    const both = asset({ id: 'd', width: 1920, height: 1080, originalFileName: 'screenshot.png', exifInfo: { make: null } })
    expect(screenshotArm(both, withRatios)).toBe('filename')
  })

  it('keeps the file name arm working with ratios off', () => {
    expect(screenshotArm(asset({ id: 'f', originalFileName: 'Screenshot.png' }), testConfig)).toBe('filename')
  })

  it('keeps screenshotShaped as the boolean view of the same rule', () => {
    const a = asset({ id: 'e', originalFileName: 'Screenshot.png' })
    expect(screenshotShaped(a, testConfig)).toBe(screenshotArm(a, testConfig) !== null)
  })
})

describe('buildFeatures', () => {
  const household = new Set(['p1', 'p2'])

  it('counts only household faces, and notices any face at all', () => {
    const a = asset({ id: 'a', people: [{ id: 'p1', name: 'Bart' }, { id: 'p9', name: 'Guest' }] })
    const f = buildFeatures(a, testConfig, household, new Set())
    expect(f.householdFaces).toBe(1)
    expect(f.anyFace).toBe(true)
  })

  it('reports no faces on an empty people list', () => {
    const f = buildFeatures(asset({ id: 'a', people: [] }), testConfig, household, new Set())
    expect(f.householdFaces).toBe(0)
    expect(f.anyFace).toBe(false)
  })

  it('needs both coordinates before it calls GPS present', () => {
    const both = buildFeatures(asset({ id: 'a' }), testConfig, household, new Set())
    expect(both.gpsPresent).toBe(true)
    const half = buildFeatures(
      asset({ id: 'b', exifInfo: { make: 'Apple', latitude: 45.1, longitude: null } }),
      testConfig,
      household,
      new Set(),
    )
    expect(half.gpsPresent).toBe(false)
  })

  it('carries the screenshot arm through to the features', () => {
    const shot = asset({ id: 's', originalFileName: 'Screenshot.png' })
    const f = buildFeatures(shot, testConfig, household, new Set())
    expect(f.screenshotShaped).toBe(true)
    expect(f.screenshotArm).toBe('filename')
  })

  it('flags membership of a trip album', () => {
    const f = buildFeatures(asset({ id: 'a' }), testConfig, household, new Set(['a']))
    expect(f.inTripAlbum).toBe(true)
  })
})

describe('featureVector', () => {
  it('emits the seven columns in a stable order and normalised range', () => {
    const v = featureVector({
      householdFaces: 8,
      anyFace: true,
      exifMakePresent: false,
      gpsPresent: true,
      screenshotShaped: false,
      inTripAlbum: true,
      isFavorite: false,
    })
    expect(v).toEqual([1, 1, 0, 1, 0, 1, 0])
  })

  it('caps the household face count so a crowd is not an outlier', () => {
    expect(featureVector({ householdFaces: 2 } as never)[0]).toBe(0.5)
  })
})

describe('resolveHousehold', () => {
  const people = [
    { id: 'p1', name: 'Bart Ledoux' },
    { id: 'p2', name: 'Thais Heintz' },
  ]

  it('resolves names case insensitively', () => {
    const out = resolveHousehold(['bart ledoux', '  Thais Heintz '], people)
    expect(out.ids).toEqual(new Set(['p1', 'p2']))
    expect(out.unmatched).toEqual([])
  })

  it('accepts an id straight through', () => {
    expect(resolveHousehold(['p2'], people).ids).toEqual(new Set(['p2']))
  })

  it('matches through a missing diacritic, which is the likeliest config typo', () => {
    const accented = [{ id: 'p3', name: 'Thaïs Heintz' }, { id: 'p4', name: 'Sébastien Ledoux' }]
    const out = resolveHousehold(['Thais Heintz', 'Sebastien Ledoux'], accented)
    expect(out.ids).toEqual(new Set(['p3', 'p4']))
    expect(out.unmatched).toEqual([])
  })

  it('prefers an exact name over a folded one', () => {
    const both = [{ id: 'pA', name: 'Thais Heintz' }, { id: 'pB', name: 'Thaïs Heintz' }]
    expect(resolveHousehold(['Thais Heintz'], both).ids).toEqual(new Set(['pA']))
    expect(resolveHousehold(['Thaïs Heintz'], both).ids).toEqual(new Set(['pB']))
  })

  it('refuses to guess when folding makes two people ambiguous', () => {
    const both = [{ id: 'pA', name: 'Thaïs Heintz' }, { id: 'pB', name: 'Thaîs Heintz' }]
    const out = resolveHousehold(['Thais Heintz'], both)
    expect(out.ids.size).toBe(0)
    expect(out.unmatched).toEqual(['Thais Heintz'])
  })

  it('reports names it could not find instead of failing silently', () => {
    const out = resolveHousehold(['Bart Ledoux', 'Nobody'], people)
    expect(out.ids).toEqual(new Set(['p1']))
    expect(out.unmatched).toEqual(['Nobody'])
  })
})
