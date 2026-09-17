import type { Asset, Config, Features } from './types.js'

/** Fixed order. The ridge model's engineered block depends on it, so only append. */
export const FEATURE_NAMES = [
  'household_faces',
  'any_face',
  'exif_make_present',
  'gps_present',
  'screenshot_shaped',
  'in_trip_album',
  'is_favorite',
] as const

/**
 * A filename match is enough on its own. A ratio match is not: 4:3 and 16:9 are camera ratios too,
 * so it only counts when the file also carries no camera make.
 */
export function screenshotShaped(asset: Asset, cfg: Config): boolean {
  const name = asset.originalFileName.toLowerCase()
  if (cfg.exif.filenamePatterns.some((p) => name.includes(p))) return true
  if (asset.exifInfo?.make) return false

  const w = asset.width ?? asset.exifInfo?.exifImageWidth ?? 0
  const h = asset.height ?? asset.exifInfo?.exifImageHeight ?? 0
  if (!w || !h) return false
  const ratio = Math.max(w, h) / Math.min(w, h)
  return cfg.exif.screenshotRatios.some((r) => Math.abs(ratio - r) <= cfg.exif.ratioTolerance)
}

export function buildFeatures(
  asset: Asset,
  cfg: Config,
  householdPersonIds: ReadonlySet<string>,
  tripAssetIds: ReadonlySet<string>,
): Features {
  const people = asset.people ?? []
  const householdFaces = people.filter((p) => householdPersonIds.has(p.id)).length
  const exif = asset.exifInfo
  return {
    householdFaces,
    anyFace: people.length > 0,
    exifMakePresent: Boolean(exif?.make),
    gpsPresent: exif?.latitude != null && exif?.longitude != null,
    screenshotShaped: screenshotShaped(asset, cfg),
    inTripAlbum: tripAssetIds.has(asset.id),
    isFavorite: asset.isFavorite,
  }
}

/** Engineered block of the design matrix. `householdFaces` is capped so a crowd shot is not an outlier. */
export function featureVector(f: Features): number[] {
  return [
    Math.min(f.householdFaces, 4) / 4,
    f.anyFace ? 1 : 0,
    f.exifMakePresent ? 1 : 0,
    f.gpsPresent ? 1 : 0,
    f.screenshotShaped ? 1 : 0,
    f.inTripAlbum ? 1 : 0,
    f.isFavorite ? 1 : 0,
  ]
}

/** Case and accent insensitive key. "Thais" and "Thaïs" fold together, so a config typo still matches. */
function fold(name: string): string {
  return name
    .trim()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
}

/**
 * Resolves configured household entries, which may be names or ids. Exact names win; a folded
 * match is the fallback, and is skipped where folding would make two people ambiguous.
 */
export function resolveHousehold(
  configured: string[],
  people: { id: string; name: string }[],
): { ids: Set<string>; unmatched: string[] } {
  const byName = new Map<string, string>()
  const byFolded = new Map<string, string | null>()
  const ids = new Set<string>()
  for (const p of people) {
    byName.set(p.name.trim().toLowerCase(), p.id)
    ids.add(p.id)
    const key = fold(p.name)
    // A second person folding to the same key makes the key useless, so poison it rather than guess.
    byFolded.set(key, byFolded.has(key) && byFolded.get(key) !== p.id ? null : p.id)
  }

  const out = new Set<string>()
  const unmatched: string[] = []
  for (const entry of configured) {
    const trimmed = entry.trim()
    if (ids.has(trimmed)) {
      out.add(trimmed)
      continue
    }
    const exact = byName.get(trimmed.toLowerCase())
    if (exact) {
      out.add(exact)
      continue
    }
    const folded = byFolded.get(fold(trimmed))
    if (folded) out.add(folded)
    else unmatched.push(entry)
  }
  return { ids: out, unmatched }
}
