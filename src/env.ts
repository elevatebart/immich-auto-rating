export interface Env {
  immichUrl: string
  immichApiKey: string
  mlUrl: string
  stateDir: string
  pg: { host: string; port: number; user: string; password: string; database: string }
}

export class EnvError extends Error {}

function need(name: string): string {
  const v = process.env[name]
  if (!v) throw new EnvError(`${name} is not set`)
  return v
}

/** Reads the environment. `needs` keeps read-only commands from demanding write-side secrets. */
export function readEnv(needs: { db?: boolean; ml?: boolean } = {}): Env {
  const pgPort = Number(process.env.PGPORT ?? 5432)
  if (!Number.isInteger(pgPort)) throw new EnvError('PGPORT must be an integer')
  return {
    immichUrl: need('IMMICH_URL').replace(/\/+$/, ''),
    immichApiKey: need('IMMICH_API_KEY'),
    mlUrl: (needs.ml ? need('IMMICH_ML_URL') : (process.env.IMMICH_ML_URL ?? '')).replace(/\/+$/, ''),
    stateDir: process.env.STATE_DIR ?? './state',
    pg: {
      host: needs.db ? need('PGHOST') : (process.env.PGHOST ?? ''),
      port: pgPort,
      user: needs.db ? need('PGUSER') : (process.env.PGUSER ?? ''),
      password: needs.db ? need('PGPASSWORD') : (process.env.PGPASSWORD ?? ''),
      database: needs.db ? need('PGDATABASE') : (process.env.PGDATABASE ?? ''),
    },
  }
}
