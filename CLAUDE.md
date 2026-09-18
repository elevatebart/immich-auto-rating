# immich-auto-rating

Rates every principal image in an Immich library 1-5, learning from the ratings the user corrects by
hand in the Immich UI. Node 24, TS strict, ESM, tsdown, vitest. Sibling of `immich-auto-albums`.

## Layout
- `src/types.ts`: the shared shapes. `Rating` is `1..5` only; Immich's `-1` and `null` never reach it.
- `src/config.ts`: `config.toml` -> `Config`. `fromToml` validates and fills defaults, TOML keys are
  snake_case and `Config` is camelCase. The only reader of the TOML format.
- `src/env.ts`: secrets, from the environment alone. `readEnv({db, ml})` so a read-only command does
  not demand the write-side secrets.
- `src/immich.ts`: fetch client. Retries 429 and 5xx with backoff and `retry-after`. `isPrincipal`
  and `isStackPrimary` are the candidate rules, pure and tested alone.
- `src/db.ts`: `smart_search` reader plus `parseVector`, `normalise`, `cosine`. Learns the vector
  width from the first row and refuses a mixed set.
- `src/ml.ts`: the ML container. `parseClipOutput` handles the double JSON encoding.
- `src/features.ts`: `buildFeatures`, `featureVector` (fixed column order), `resolveHousehold`.
- `src/state.ts`: SQLite on `node:sqlite`. `classify` is pure and holds every correction rule.
- `src/zeroshot.ts`: cold start. `promptScore`, `rankFractions`, `scoreZeroShot`.
- `src/ridge.ts`: normal equations, Cholesky with a jitter retry, `kFoldMae`.
- `src/pool.ts`: `planPool` is pure, `applyPool` does the I/O.
- `src/write.ts`: groups by rating, one bulk `PUT /assets` per batch, capped concurrency.
- `src/run.ts`: the orchestrator. `prepare` (enumerate, sync, build features), `score`, `refit`.
- `src/cli.ts`: the verbs. The only place that decides an exit code.

## Invariants
- **Ratings on Immich 3 are `-1` or `1..5` or `null`. `0` is invalid and must never be sent.**
  `null` is unrated. We only ever write `1..5`. See `docs/immich-contract.md`.
- Every search goes through `filter: SearchFilter`, never the flat fields. They are all deprecated
  as of 3.2.0 and the flat `rating` is exact-match only. Page with `cursor`/`nextCursor`, not `page`.
- A frozen asset is never written again, ever. `recordWrite` carries `WHERE assets.frozen = 0` so
  even a caller that forgets the check cannot clobber a label.
- `stack.primaryAssetId === id` is the principal test. `withStacked` is not a substitute: it drops
  whole stacks rather than folding them, which the sibling planner found the hard way.
- A ratio match alone never means screenshot. It only counts alongside a missing EXIF camera make,
  or the file name says so outright. 4:3 and 16:9 are camera ratios.
- Zero-shot buckets are assigned **on rank**, not on the raw softmax value. A CLIP softmax saturates
  near 0 and 1, so value thresholds collapse into two buckets. There is a test that pins this.
- `Scored.uncertainty` is confidence, smallest first in the report. For zero-shot it is
  `|positiveMass - 0.5|`, how torn the prompt softmax is. It is **not** distance to a quantile
  boundary: ranks over 18k assets are 0.00005 apart, so that measure put ~70 assets at zero and the
  correction list degenerated into the first 30 by id.
- Rank mapping makes ratings **relative**. The bottom `quantiles[0]` share of the library gets 1 star
  whatever it holds, so the buckets say nothing about absolute quality and the pool share is set by
  the cut points, not by how many good photos there are.
- The ML container returns the CLIP vector **JSON encoded twice** and **not normalised**. Both are
  handled in `ml.ts` and both have tests.
- The prompt embedding width and the `smart_search` width are compared before scoring. A mismatch
  means the ML container and the stored vectors are different CLIP models, and the run is refused
  rather than scored across two spaces.
- The pool album never loses an asset the run did not score. `planPool` takes `seen` for exactly this.
- Every forcing rule names **why** it fired in `Scored.detail`: which screenshot arm (`filename` or
  `ratio`), or the text of the negative prompt that won. The report keys its rule breakdown on
  `rule: detail`, so a misfiring prompt or arm is a count rather than an inference. A hand review of
  80 sampled assets put screenshot at 3/8 correct and negative-prompt at 7/9, which is the reason
  this exists.
- Pure where it can be: `classify`, `planPool`, `promptScore`, `rankFractions`, `fit`, `isPrincipal`,
  `buildFeatures`. The tests reach those directly and never touch the network.

## Code style
- Comments and JSDoc at most 2 lines. No em dashes anywhere. Straight quotes.
- Small pure functions; the only class is the API client and the two stores.
- JSON logs through `src/log.ts`, never bare `console.log`.

## Config files
- `config.toml` is local and gitignored: it holds the household names. `config.example.toml` is the
  committed starting point and `test/fixtures/config.toml` is the tests' own copy.
- Secrets are only ever in `.env` or the environment. Never config, never logs.

## Tests
- `npm test` runs offline. Fixtures for API responses, embeddings and DB rows, no network at all.
- Covered: candidate filtering and the stack primary rule, correction detection, first-run label
  import, zero-shot rank mapping, ridge fit on a toy set, pool reconciliation, the ML double
  encoding, retry and backoff, report ordering.
- Run `npm test` and `npm run typecheck` before and after any scoring change.

## Delivery
- `Dockerfile`: build on `node:24-alpine`, run on the same as `node`, `tini` as PID 1. No native
  modules on purpose: `node:sqlite` is built in and `pg` is pure JS, so there is nothing to compile.
- `docker/entrypoint.sh` dispatches the verbs, anything else runs verbatim.
- Never bake `config.toml` into an image, `.dockerignore` excludes it.
- **No scheduler inside the app.** One invocation, one run, exit. DSM Task Scheduler does the timing.
- The DSM task must run as **root**: the Docker socket on DSM is root-owned with no usable `docker`
  group. The container itself still runs as `node`, uid 1000.
- The mount must live on `/volume1/docker`, not on a share created through the DSM UI. Those are
  ACL-only: mode `000` with one `group:administrators` entry, POSIX inert, `chown` a silent no-op,
  and `synoacltool` will not grant a uid that has no DSM account. A non-root container cannot read
  them at all. `/volume1/docker` has real POSIX bits, but new directories inherit mode `555`, so the
  task needs `chown` **and** `chmod -R u+rwX`, on every run, because File Station uploads undo both.
- The Immich stack on that host is the `immich-photos` compose project, so the external network is
  `immich-photos_default`. An unrelated `immich_default` exists on the same host and resolves nothing.

## Releases
- `.github/workflows/ci.yml` runs typecheck, tests and build. `image.yml` publishes `linux/amd64` to
  GHCR: `main` moves `latest`, a `v*` tag adds the version. Docs and scripts do not trigger a build.
- The repository is public, so **no private hostnames or ids in tracked files**. The contract doc
  records the Immich version and says `live` for what was probed, never the address.
