import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { StateRow } from './types.js'

export type SyncAction =
  | { kind: 'none' }
  | { kind: 'import'; label: number }
  | { kind: 'freeze'; label: number }
  | { kind: 'relabel'; label: number }
  | { kind: 'reset' }

/** A hand rejection is the strongest negative the user can express, so it trains as a 1. */
export function toLabel(rating: number): number {
  if (rating === -1) return 1
  return Math.min(5, Math.max(1, Math.round(rating)))
}

/**
 * Decides what a run makes of an asset whose current Immich rating is `current`.
 * `row` is undefined when the asset has never been seen. Pure, so the rules are testable alone.
 */
export function classify(row: StateRow | undefined, current: number | null): SyncAction {
  if (!row) {
    // Never seen. A rating already on the asset is the user's, so it becomes a label untouched.
    return current == null ? { kind: 'none' } : { kind: 'import', label: toLabel(current) }
  }
  if (current == null) {
    // Cleared by hand. Forget what we knew and let the next run rate it again.
    return row.ratingWritten == null && !row.frozen ? { kind: 'none' } : { kind: 'reset' }
  }
  if (row.frozen) {
    return toLabel(current) === row.label ? { kind: 'none' } : { kind: 'relabel', label: toLabel(current) }
  }
  if (row.ratingWritten == null) return { kind: 'import', label: toLabel(current) }
  return current === row.ratingWritten ? { kind: 'none' } : { kind: 'freeze', label: toLabel(current) }
}

export class State {
  private readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.migrate()
  }

  static open(stateDir: string): State {
    mkdirSync(stateDir, { recursive: true })
    return new State(join(stateDir, 'state.sqlite'))
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS assets (
        asset_id TEXT PRIMARY KEY,
        rating_written INTEGER,
        rated_at TEXT,
        frozen INTEGER NOT NULL DEFAULT 0,
        label INTEGER,
        model_version TEXT
      );
      CREATE INDEX IF NOT EXISTS assets_frozen ON assets(frozen);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `)
  }

  get(assetId: string): StateRow | undefined {
    const r = this.db.prepare('SELECT * FROM assets WHERE asset_id = ?').get(assetId) as
      | Record<string, unknown>
      | undefined
    return r ? toRow(r) : undefined
  }

  all(): StateRow[] {
    return (this.db.prepare('SELECT * FROM assets').all() as Record<string, unknown>[]).map(toRow)
  }

  labels(): { assetId: string; label: number }[] {
    const rows = this.db
      .prepare('SELECT asset_id, label FROM assets WHERE frozen = 1 AND label IS NOT NULL')
      .all() as Record<string, unknown>[]
    return rows.map((r) => ({ assetId: String(r['asset_id']), label: Number(r['label']) }))
  }

  frozenIds(): Set<string> {
    const rows = this.db.prepare('SELECT asset_id FROM assets WHERE frozen = 1').all() as Record<
      string,
      unknown
    >[]
    return new Set(rows.map((r) => String(r['asset_id'])))
  }

  isFirstRun(): boolean {
    return this.meta('first_run_done') !== 'yes'
  }

  markFirstRunDone(): void {
    this.setMeta('first_run_done', 'yes')
  }

  meta(key: string): string | undefined {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | Record<string, unknown>
      | undefined
    return r ? String(r['value']) : undefined
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value)
  }

  /** Applies one classification. Returns the action so the caller can count it. */
  apply(assetId: string, current: number | null, action: SyncAction): SyncAction {
    switch (action.kind) {
      case 'none':
        return action
      case 'import':
      case 'freeze':
      case 'relabel':
        this.db
          .prepare(
            `INSERT INTO assets (asset_id, rating_written, rated_at, frozen, label, model_version)
             VALUES (?, ?, NULL, 1, ?, NULL)
             ON CONFLICT(asset_id) DO UPDATE SET rating_written = excluded.rating_written,
               frozen = 1, label = excluded.label`,
          )
          .run(assetId, current, action.label)
        return action
      case 'reset':
        this.db
          .prepare(
            `INSERT INTO assets (asset_id, rating_written, rated_at, frozen, label, model_version)
             VALUES (?, NULL, NULL, 0, NULL, NULL)
             ON CONFLICT(asset_id) DO UPDATE SET rating_written = NULL, rated_at = NULL,
               frozen = 0, label = NULL, model_version = NULL`,
          )
          .run(assetId)
        return action
    }
  }

  /** Records a rating this run wrote. Called per batch so a crash resumes instead of rewriting. */
  recordWrite(assetId: string, rating: number, modelVersion: string): void {
    this.db
      .prepare(
        `INSERT INTO assets (asset_id, rating_written, rated_at, frozen, label, model_version)
         VALUES (?, ?, ?, 0, NULL, ?)
         ON CONFLICT(asset_id) DO UPDATE SET rating_written = excluded.rating_written,
           rated_at = excluded.rated_at, model_version = excluded.model_version
         WHERE assets.frozen = 0`,
      )
      .run(assetId, rating, new Date().toISOString(), modelVersion)
  }

  /** Freezes an asset by hand, taking its current rating as the label. */
  freeze(assetId: string, label: number): void {
    this.db
      .prepare(
        `INSERT INTO assets (asset_id, rating_written, rated_at, frozen, label, model_version)
         VALUES (?, ?, NULL, 1, ?, NULL)
         ON CONFLICT(asset_id) DO UPDATE SET frozen = 1, label = excluded.label`,
      )
      .run(assetId, label, label)
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const out = fn()
      this.db.exec('COMMIT')
      return out
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  close(): void {
    this.db.close()
  }
}

function toRow(r: Record<string, unknown>): StateRow {
  return {
    assetId: String(r['asset_id']),
    ratingWritten: r['rating_written'] == null ? null : Number(r['rating_written']),
    ratedAt: r['rated_at'] == null ? null : String(r['rated_at']),
    frozen: Number(r['frozen']) === 1,
    label: r['label'] == null ? null : Number(r['label']),
    modelVersion: r['model_version'] == null ? null : String(r['model_version']),
  }
}
