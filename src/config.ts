import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'smol-toml'
import type { Config } from './types.js'

const DEFAULTS = {
  poolAlbum: 'Wallpaper pool',
  poolMinRating: 4,
  ratioTolerance: 0.012,
  lambda: 1,
  minLabels: 150,
  folds: 5,
  negativeMargin: 0.15,
  quantiles: [0.15, 0.4, 0.7, 0.9],
  batchSize: 250,
  concurrency: 4,
  maxRetries: 5,
}

class ConfigError extends Error {}

const isTable = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function table(root: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = root[key]
  if (v === undefined) return {}
  if (!isTable(v)) throw new ConfigError(`[${key}] must be a table`)
  return v
}

function strings(t: Record<string, unknown>, key: string, where: string, fallback?: string[]): string[] {
  const v = t[key]
  if (v === undefined) {
    if (fallback) return fallback
    throw new ConfigError(`${where}.${key} is required`)
  }
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new ConfigError(`${where}.${key} must be an array of strings`)
  }
  return v as string[]
}

function numbers(t: Record<string, unknown>, key: string, where: string, fallback: number[]): number[] {
  const v = t[key]
  if (v === undefined) return fallback
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'number')) {
    throw new ConfigError(`${where}.${key} must be an array of numbers`)
  }
  return v as number[]
}

function num(t: Record<string, unknown>, key: string, where: string, fallback: number): number {
  const v = t[key]
  if (v === undefined) return fallback
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ConfigError(`${where}.${key} must be a number`)
  return v
}

function str(t: Record<string, unknown>, key: string, where: string, fallback: string): string {
  const v = t[key]
  if (v === undefined) return fallback
  if (typeof v !== 'string') throw new ConfigError(`${where}.${key} must be a string`)
  return v
}

export function fromToml(text: string): Config {
  const root = parse(text) as Record<string, unknown>
  const household = table(root, 'household')
  const prompts = table(root, 'prompts')
  const pool = table(root, 'pool')
  const exif = table(root, 'exif')
  const albums = table(root, 'albums')
  const ridge = table(root, 'ridge')
  const zeroshot = table(root, 'zeroshot')
  const ml = table(root, 'ml')
  const write = table(root, 'write')

  const cfg: Config = {
    household: { persons: strings(household, 'persons', 'household', []) },
    prompts: {
      positive: strings(prompts, 'positive', 'prompts'),
      negative: strings(prompts, 'negative', 'prompts'),
    },
    pool: {
      album: str(pool, 'album', 'pool', DEFAULTS.poolAlbum),
      minRating: num(pool, 'min_rating', 'pool', DEFAULTS.poolMinRating),
    },
    exif: {
      screenshotRatios: numbers(exif, 'screenshot_ratios', 'exif', []),
      ratioTolerance: num(exif, 'ratio_tolerance', 'exif', DEFAULTS.ratioTolerance),
      filenamePatterns: strings(exif, 'filename_patterns', 'exif', []).map((p) => p.toLowerCase()),
    },
    albums: { tripPatterns: strings(albums, 'trip_patterns', 'albums', []).map((p) => p.toLowerCase()) },
    ridge: {
      lambda: num(ridge, 'lambda', 'ridge', DEFAULTS.lambda),
      minLabels: num(ridge, 'min_labels', 'ridge', DEFAULTS.minLabels),
      folds: num(ridge, 'folds', 'ridge', DEFAULTS.folds),
    },
    zeroshot: {
      negativeMargin: num(zeroshot, 'negative_margin', 'zeroshot', DEFAULTS.negativeMargin),
      quantiles: numbers(zeroshot, 'quantiles', 'zeroshot', DEFAULTS.quantiles),
    },
    ml: { modelName: str(ml, 'model_name', 'ml', '') },
    write: {
      batchSize: num(write, 'batch_size', 'write', DEFAULTS.batchSize),
      concurrency: num(write, 'concurrency', 'write', DEFAULTS.concurrency),
      maxRetries: num(write, 'max_retries', 'write', DEFAULTS.maxRetries),
    },
  }
  validate(cfg)
  return cfg
}

function validate(cfg: Config): void {
  if (cfg.prompts.positive.length === 0) throw new ConfigError('prompts.positive must not be empty')
  if (cfg.prompts.negative.length === 0) throw new ConfigError('prompts.negative must not be empty')
  if (!Number.isInteger(cfg.pool.minRating) || cfg.pool.minRating < 1 || cfg.pool.minRating > 5) {
    throw new ConfigError('pool.min_rating must be an integer in 1..5')
  }
  if (cfg.ridge.lambda <= 0) throw new ConfigError('ridge.lambda must be positive')
  if (cfg.ridge.folds < 2) throw new ConfigError('ridge.folds must be at least 2')
  if (cfg.zeroshot.quantiles.length !== 4) {
    throw new ConfigError('zeroshot.quantiles must hold exactly 4 cut points, giving the 1..5 buckets')
  }
  const q = cfg.zeroshot.quantiles
  for (let i = 0; i < q.length; i++) {
    const v = q[i]!
    if (v <= 0 || v >= 1) throw new ConfigError('zeroshot.quantiles must sit strictly between 0 and 1')
    if (i > 0 && v <= q[i - 1]!) throw new ConfigError('zeroshot.quantiles must increase')
  }
  if (cfg.write.batchSize < 1) throw new ConfigError('write.batch_size must be at least 1')
  if (cfg.write.concurrency < 1) throw new ConfigError('write.concurrency must be at least 1')
}

export function loadConfig(path: string): Config {
  try {
    return fromToml(readFileSync(path, 'utf8'))
  } catch (e) {
    if (e instanceof ConfigError) throw e
    throw new ConfigError(readFailure(path, e))
  }
}

/** The container cannot be poked at by hand, so say which path and which failure, not just "cannot read". */
function readFailure(path: string, e: unknown): string {
  const full = resolve(path)
  const code = (e as NodeJS.ErrnoException)?.code
  const who = `running as uid ${typeof process.getuid === 'function' ? process.getuid() : 'unknown'}`
  switch (code) {
    case 'ENOENT':
      return `no config at ${full} (${who}). Copy config.example.toml there, or point CONFIG elsewhere.`
    case 'EACCES':
    case 'EPERM':
      return `${full} exists but is not readable ${who}. chown it to 1000:1000, or chmod a+r.`
    case 'EISDIR':
      return `${full} is a directory, not a file. CONFIG must name the config.toml itself.`
    default:
      return `cannot read ${full} (${who}): ${code ?? (e instanceof Error ? e.message : String(e))}`
  }
}

export { ConfigError }
