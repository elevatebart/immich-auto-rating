/** Immich rating on a v3 server. 0 is invalid, null means unrated, -1 means rejected. */
export type Rating = 1 | 2 | 3 | 4 | 5

export interface Config {
  household: { persons: string[] }
  prompts: { positive: string[]; negative: string[] }
  pool: { album: string; minRating: number }
  exif: {
    screenshotRatios: number[]
    ratioTolerance: number
    filenamePatterns: string[]
  }
  albums: { tripPatterns: string[] }
  ridge: { lambda: number; minLabels: number; folds: number }
  zeroshot: { negativeMargin: number; quantiles: number[] }
  ml: { modelName: string }
  write: { batchSize: number; concurrency: number; maxRetries: number }
}

export interface AssetStack {
  id: string
  primaryAssetId: string
  assetCount: number
}

export interface AssetPerson {
  id: string
  name: string
}

export interface ExifInfo {
  make?: string | null
  model?: string | null
  latitude?: number | null
  longitude?: number | null
  exifImageWidth?: number | null
  exifImageHeight?: number | null
}

export interface Asset {
  id: string
  type: string
  visibility: string
  isTrashed: boolean
  isArchived: boolean
  isFavorite: boolean
  rating?: number | null
  localDateTime: string
  originalFileName: string
  width?: number | null
  height?: number | null
  stack?: AssetStack | null
  people?: AssetPerson[]
  exifInfo?: ExifInfo | null
}

/** Engineered features, in the fixed order `featureVector` emits. */
export interface Features {
  householdFaces: number
  anyFace: boolean
  exifMakePresent: boolean
  gpsPresent: boolean
  screenshotShaped: boolean
  /** Which arm of the screenshot rule fired, for the report. Not a model feature. */
  screenshotArm?: 'filename' | 'ratio' | null
  inTripAlbum: boolean
  isFavorite: boolean
}

export interface Candidate {
  asset: Asset
  features: Features
  embedding?: Float64Array
}

/** Which rule settled the rating, so the report can show why a bucket is the size it is. */
export type Rule = 'quantile' | 'household-bump' | 'screenshot' | 'negative-prompt'

export interface Scored {
  id: string
  rating: Rating
  /** Confidence, 0 (a coin flip) to 0.5 (certain). The report ranks the smallest first. */
  uncertainty: number
  raw: number
  reason: 'zero-shot' | 'ridge'
  rule?: Rule
  /** Narrows the rule: which screenshot arm, or which prompt won. */
  detail?: string
}

export interface StateRow {
  assetId: string
  ratingWritten: number | null
  ratedAt: string | null
  frozen: boolean
  label: number | null
  modelVersion: string | null
}
