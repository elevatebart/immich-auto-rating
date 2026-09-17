import type { Config, Candidate, Scored } from './types.js'
import { ImmichClient, isPrincipal } from './immich.js'
import { PgEmbeddingStore, type EmbeddingStore } from './db.js'
import { MlClient, embedPrompts } from './ml.js'
import { buildFeatures, resolveHousehold } from './features.js'
import { State, classify } from './state.js'
import { scoreZeroShot } from './zeroshot.js'
import { kFoldMae, scoreRidge, trainModel } from './ridge.js'
import type { Env } from './env.js'
import { log } from './log.js'

export interface Corrections {
  imported: number
  frozen: number
  relabelled: number
  reset: number
}

export interface Prepared {
  candidates: Candidate[]
  corrections: Corrections
  labelled: { candidate: Candidate; label: number }[]
  frozenIds: Set<string>
  modelName: string
  firstRun: boolean
}

/** Candidate enumeration, correction sync and feature build. No scoring and no writes. */
export async function prepare(
  cfg: Config,
  client: ImmichClient,
  state: State,
  store: EmbeddingStore,
): Promise<Prepared> {
  const firstRun = state.isFirstRun()

  const people = await client.getPeople()
  const household = resolveHousehold(cfg.household.persons, people)
  if (household.unmatched.length > 0) {
    log.warn('household.unmatched', { names: household.unmatched })
  }

  const albums = await client.getAlbums()
  const tripAssetIds = new Set<string>()
  if (cfg.albums.tripPatterns.length > 0) {
    for (const album of albums) {
      const name = album.albumName.toLowerCase()
      if (!cfg.albums.tripPatterns.some((p) => name.includes(p))) continue
      for (const id of await client.albumAssetIds(album.id)) tripAssetIds.add(id)
    }
  }

  const raw = await client.searchCandidates()
  const seen = new Set<string>()
  const assets = raw.filter((a) => isPrincipal(a) && !seen.has(a.id) && seen.add(a.id))
  log.info('candidates.found', { fetched: raw.length, principal: assets.length })

  const corrections: Corrections = { imported: 0, frozen: 0, relabelled: 0, reset: 0 }
  state.transaction(() => {
    for (const asset of assets) {
      const action = classify(state.get(asset.id), asset.rating ?? null)
      if (action.kind === 'none') continue
      state.apply(asset.id, asset.rating ?? null, action)
      if (action.kind === 'import') corrections.imported++
      else if (action.kind === 'freeze') corrections.frozen++
      else if (action.kind === 'relabel') corrections.relabelled++
      else corrections.reset++
    }
  })
  log.info('corrections.synced', { ...corrections, firstRun })

  const embeddings = await store.fetch(assets.map((a) => a.id))
  const candidates: Candidate[] = assets.map((asset) => ({
    asset,
    features: buildFeatures(asset, cfg, household.ids, tripAssetIds),
    embedding: embeddings.get(asset.id),
  }))

  const frozenIds = state.frozenIds()
  const labelByAsset = new Map(state.labels().map((l) => [l.assetId, l.label]))
  const labelled = candidates
    .filter((c) => c.embedding && labelByAsset.has(c.asset.id))
    .map((c) => ({ candidate: c, label: labelByAsset.get(c.asset.id)! }))

  const modelName = cfg.ml.modelName || (await resolveModelName(client))
  return { candidates, corrections, labelled, frozenIds, modelName, firstRun }
}

async function resolveModelName(client: ImmichClient): Promise<string> {
  try {
    return await client.clipModelName()
  } catch (e) {
    throw new Error(
      `cannot read machineLearning.clip.modelName (${e instanceof Error ? e.message : e}). ` +
        'Grant the key adminConfig.read, or set ml.model_name in config.toml.',
    )
  }
}

export interface Plan {
  scored: Scored[]
  mode: 'zero-shot' | 'ridge'
  labelCount: number
  skippedFrozen: number
  noEmbedding: number
}

/** Chooses cold start or learned, and scores only the assets this run is allowed to write. */
export async function score(cfg: Config, env: Env, prep: Prepared): Promise<Plan> {
  const targets = prep.candidates.filter((c) => !prep.frozenIds.has(c.asset.id))
  const skippedFrozen = prep.candidates.length - targets.length
  const scorable = targets.filter((c) => c.embedding)
  const noEmbedding = targets.length - scorable.length
  if (noEmbedding > 0) log.warn('score.no_embedding', { count: noEmbedding })

  if (prep.labelled.length >= cfg.ridge.minLabels) {
    const model = trainModel(prep.labelled, cfg.ridge.lambda, `ridge-${prep.modelName}`)
    log.info('model.trained', { labels: prep.labelled.length, dim: model.embeddingDim })
    return {
      scored: scoreRidge(model, scorable),
      mode: 'ridge',
      labelCount: prep.labelled.length,
      skippedFrozen,
      noEmbedding,
    }
  }

  const ml = new MlClient(env.mlUrl, prep.modelName)
  await ml.ping()
  const prompts = await embedPrompts(ml, cfg.prompts.positive, cfg.prompts.negative)
  const width = prompts.vectors[0]!.length
  const assetWidth = scorable[0]?.embedding?.length ?? width
  if (width !== assetWidth) {
    throw new Error(
      `prompt embeddings are ${width} wide but smart_search holds ${assetWidth}. ` +
        `The ML container and the stored vectors are not the same CLIP model (${prep.modelName}).`,
    )
  }
  log.info('model.zero_shot', { prompts: prompts.vectors.length, labels: prep.labelled.length })
  return {
    scored: scoreZeroShot(scorable, prompts, cfg),
    mode: 'zero-shot',
    labelCount: prep.labelled.length,
    skippedFrozen,
    noEmbedding,
  }
}

export function refit(cfg: Config, prep: Prepared): { mae: number; folds: number; n: number } {
  if (prep.labelled.length < 2) {
    throw new Error(`need at least 2 frozen labels to refit, have ${prep.labelled.length}`)
  }
  return kFoldMae(prep.labelled, cfg.ridge.lambda, cfg.ridge.folds)
}

export function openStore(env: Env): EmbeddingStore {
  return new PgEmbeddingStore(env)
}

export { ImmichClient }
