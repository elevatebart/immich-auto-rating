#!/usr/bin/env node
import { loadConfig } from './config.js'
import { readEnv } from './env.js'
import { ImmichClient } from './immich.js'
import { State, toLabel } from './state.js'
import { openStore, prepare, refit, score } from './run.js'
import { applyPool, findAlbum, planPool } from './pool.js'
import { writeRatings } from './write.js'
import { buildReport, formatReport } from './report.js'
import { log } from './log.js'
import type { EmbeddingStore } from './db.js'

const USAGE = `immich-auto-rating <command>

  scan              enumerate candidates, sync corrections, build features. No writes.
  rate --dry-run    score every candidate and print the plan. No writes.
  apply             score, write ratings to Immich, reconcile the pool album.
  report            print counts per rating and the 30 least certain, with web links.
  refit             retrain from frozen labels and print the k-fold MAE.
  freeze <id...>    freeze assets by hand, taking their current Immich rating as the label.

Options
  --config <path>   config.toml location, else CONFIG, else ./config.toml
  --top <n>         how many uncertain assets report prints (default 30)
  --sample <n>      also print n representative links per rating and per rule
`

interface Args {
  command: string
  rest: string[]
  config: string
  dryRun: boolean
  top: number
  sample: number
}

function parseArgs(argv: string[]): Args {
  const rest: string[] = []
  let config = process.env.CONFIG ?? './config.toml'
  let dryRun = false
  let top = 30
  let sample = 0
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--config') config = argv[++i] ?? config
    else if (a === '--top') top = Number(argv[++i] ?? top)
    else if (a === '--sample') sample = Number(argv[++i] ?? sample)
    else if (a === '--dry-run') dryRun = true
    else rest.push(a)
  }
  return { command: rest[0] ?? '', rest: rest.slice(1), config, dryRun, top, sample }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  if (!args.command || args.command === 'help' || args.command === '--help') {
    process.stdout.write(USAGE)
    return 0
  }

  const cfg = loadConfig(args.config)
  // report scores too, so it needs the ML container on a cold start run.
  const needsMl = ['rate', 'apply', 'report'].includes(args.command)
  const env = readEnv({ db: args.command !== 'freeze', ml: needsMl })
  const state = State.open(env.stateDir)

  if (args.command === 'freeze') {
    try {
      return await freeze(args.rest, env, state)
    } finally {
      state.close()
    }
  }

  const client = new ImmichClient(env.immichUrl, env.immichApiKey, { maxRetries: cfg.write.maxRetries })
  const store: EmbeddingStore = openStore(env)
  try {
    const prep = await prepare(cfg, client, state, store)

    if (args.command === 'scan') {
      log.info('scan.done', {
        candidates: prep.candidates.length,
        withEmbedding: prep.candidates.filter((c) => c.embedding).length,
        labels: prep.labelled.length,
        frozen: prep.frozenIds.size,
        corrections: prep.corrections,
        clipModel: prep.modelName,
      })
      state.markFirstRunDone()
      return 0
    }

    if (args.command === 'refit') {
      const result = refit(cfg, prep)
      log.info('refit.done', { ...result, lambda: cfg.ridge.lambda })
      process.stdout.write(`k-fold MAE ${result.mae.toFixed(3)} over ${result.n} labels, ${result.folds} folds\n`)
      return 0
    }

    const plan = await score(cfg, env, prep)

    if (args.command === 'report') {
      const report = buildReport(plan.scored, env.immichUrl, args.top, cfg.pool.minRating, args.sample)
      log.info('report', {
        mode: plan.mode,
        counts: report.counts,
        rules: report.rules,
        pool: { minRating: cfg.pool.minRating, size: report.poolSize },
        total: report.total,
      })
      process.stdout.write(formatReport(report, plan.mode) + '\n')
      return 0
    }

    if (args.command === 'rate') {
      const report = buildReport(plan.scored, env.immichUrl, args.top, cfg.pool.minRating, args.sample)
      log.info('rate.plan', {
        mode: plan.mode,
        dryRun: true,
        counts: report.counts,
        rules: report.rules,
        pool: { minRating: cfg.pool.minRating, size: report.poolSize },
        total: report.total,
        skippedFrozen: plan.skippedFrozen,
        noEmbedding: plan.noEmbedding,
      })
      process.stdout.write(formatReport(report, plan.mode) + '\n')
      if (!args.dryRun) {
        log.warn('rate.dry_run_only', { hint: 'rate never writes. Use apply.' })
      }
      return 0
    }

    if (args.command === 'apply') {
      return await apply(cfg, env, client, state, plan, prep.candidates.length)
    }

    process.stderr.write(USAGE)
    return 2
  } finally {
    await store.close().catch(() => {})
    state.close()
  }
}

async function apply(
  cfg: ReturnType<typeof loadConfig>,
  env: ReturnType<typeof readEnv>,
  client: ImmichClient,
  state: State,
  plan: Awaited<ReturnType<typeof score>>,
  candidateCount: number,
): Promise<number> {
  const result = await writeRatings(
    client,
    plan.scored,
    { batchSize: cfg.write.batchSize, concurrency: cfg.write.concurrency },
    (ids, rating) => {
      state.transaction(() => {
        for (const id of ids) state.recordWrite(id, rating, plan.mode)
      })
    },
  )

  const eligible = plan.scored.filter((s) => s.rating >= cfg.pool.minRating).length
  let pool = { albumId: '', added: 0, removed: 0 }
  if (cfg.pool.album) {
    try {
      const ids = new Set(plan.scored.filter((s) => s.rating >= cfg.pool.minRating).map((s) => s.id))
      const seen = new Set(plan.scored.map((s) => s.id))
      const album = findAlbum(await client.getAlbums(), cfg.pool.album)
      const current = album ? await client.albumAssetIds(album.id) : new Set<string>()
      pool = await applyPool(client, cfg.pool.album, planPool(ids, current, seen, Boolean(album)), album?.id)
    } catch (e) {
      log.error('pool.failed', { error: e instanceof Error ? e.message : String(e) })
      result.failed.push({ ids: [], rating: 0, error: 'pool reconciliation failed' })
    }
  }

  state.markFirstRunDone()
  const failedAssets = result.failed.reduce((n, f) => n + f.ids.length, 0)
  log.info('apply.done', {
    mode: plan.mode,
    candidates: candidateCount,
    written: result.written,
    failed: failedAssets,
    skippedFrozen: plan.skippedFrozen,
    noEmbedding: plan.noEmbedding,
    pool: cfg.pool.album
      ? { album: cfg.pool.album, added: pool.added, removed: pool.removed }
      : { album: null, atOrAbove: cfg.pool.minRating, matching: eligible },
  })

  if (result.failed.length > 0) {
    log.error('apply.partial_failure', {
      batches: result.failed.length,
      assets: failedAssets,
      errors: [...new Set(result.failed.map((f) => f.error))].slice(0, 5),
    })
    return 1
  }
  return 0
}

async function freeze(ids: string[], env: ReturnType<typeof readEnv>, state: State): Promise<number> {
  if (ids.length === 0) {
    process.stderr.write('freeze needs at least one asset id\n')
    return 2
  }
  const client = new ImmichClient(env.immichUrl, env.immichApiKey)
  let failed = 0
  for (const id of ids) {
    try {
      const asset = await client.request<{ rating?: number | null }>('GET', `/assets/${id}`)
      if (asset.rating == null) {
        log.error('freeze.unrated', { id, hint: 'rate it in Immich first, a frozen asset needs a label' })
        failed++
        continue
      }
      state.freeze(id, toLabel(asset.rating))
      log.info('freeze.done', { id, label: toLabel(asset.rating) })
    } catch (e) {
      log.error('freeze.failed', { id, error: e instanceof Error ? e.message : String(e) })
      failed++
    }
  }
  return failed > 0 ? 1 : 0
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    log.error('fatal', { error: e instanceof Error ? e.message : String(e) })
    process.exit(1)
  })
