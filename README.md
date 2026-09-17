# immich-auto-rating

Gives every principal image in an Immich library a 1-5 `rating`, leaning towards photos of the
household and pushing receipts, screenshots and documents to 1. Runs monthly on the NAS, writes
nothing you have touched by hand, and learns from the ratings you correct in the Immich UI.

Sibling of `immich-auto-albums`: same toolchain, same conventions, same shape of scheduled run.

Verified against Immich **3.2.0**. The API and database facts it depends on, and how each was
established, are in [docs/immich-contract.md](docs/immich-contract.md). Read that before an upgrade.

## How it decides

**Cold start**, until the state DB holds `ridge.min_labels` corrections. Every prompt in
`prompts.positive` and `prompts.negative` is embedded once per run through the ML container, then
each asset's stored CLIP vector is scored with a softmax over all prompts at once. The positive
mass is the score. Assets are bucketed **by rank**, not by raw value, because a CLIP softmax
saturates near 0 and 1 and value thresholds would collapse into two buckets.

Then the overrides: `+1` (capped at 5) when a household face is in the frame, and a hard `1` when
the asset is screenshot shaped or a negative prompt beats every positive one by
`zeroshot.negative_margin`.

**Learned**, once there are enough labels. Ridge regression on `[CLIP embedding, 7 engineered
features, bias]` against the frozen ratings, clamped and rounded to 1-5. The bias column is never
penalised. `refit` prints the k-fold MAE so you can see whether more corrections are paying off.

### The correction loop

You never rate by hand. You correct, in the Immich UI, whatever the report says it was least sure
about. On the next run the CLI notices the rating no longer matches what it wrote, **freezes that
asset forever** and keeps the new value as a training label. `report` ranks by distance to the
nearest half-star boundary, so the 30 it prints are the 30 corrections worth the most.

A rating you clear in Immich is read as "rate this again": the asset is unfrozen and the state row
is reset.

## Ratings on Immich 3

The accepted range is `-1` to `5`, and **`0` is no longer valid**. `null` means unrated, `-1` means
rejected. This CLI only ever writes `1`-`5`. A `-1` you set by hand counts as a correction and
trains as a `1`.

## Install and run locally

    npm ci && npm test && npm run build
    cp config.example.toml config.toml   # gitignored, holds your household names
    cp .env.example .env                 # gitignored, holds the secrets

    npm run scan                         # enumerate and sync corrections, no writes
    npm run rate                         # score everything and print the plan, no writes
    npm run report                       # counts plus the 30 to go correct
    npm run apply                        # write ratings and reconcile the pool album
    npm run refit                        # k-fold MAE over the frozen labels

### Commands

| Command | Writes to Immich | What it does |
|---|---|---|
| `scan` | no | Enumerates candidates, syncs corrections, builds features. |
| `rate --dry-run` | no | Scores everything and prints the plan. |
| `apply` | **yes** | Writes ratings, then reconciles the pool album. |
| `report` | no | Counts per rating, plus the 30 least certain with web links. |
| `refit` | no | Retrains from frozen labels, prints k-fold MAE. |
| `freeze <id...>` | no | Freezes assets by hand, taking their current rating as the label. |

All of them take `--config <path>`; `report` and `rate` take `--top <n>` and `--sample <n>`.

`--sample <n>` prints n representative links per rating and per rule, spread evenly through each
bucket by score rather than taken off one end. Use it before the first `apply`: the counts tell you
the buckets are the right size, but only looking tells you whether the prompts put good photographs
at the top and receipts at the bottom. The `rule negative-prompt` sample is the one to check
hardest, since that rule sends assets to 1 star on CLIP's say-so alone, and a saturated softmax
means it is always confident whether or not it is right.

Logs are JSON on stdout, warnings and errors on stderr. A run that failed to write some batches
exits non-zero after logging `apply.partial_failure` with the counts.

## Configuration

`config.toml`, next to the binary or at `CONFIG`. It holds no secrets. Start from
`config.example.toml`, which documents every key. The ones worth a second look:

- `household.persons`: Immich person names, or ids when two people share a name. Names that do not
  resolve are logged as `household.unmatched` rather than failing the run.
- `exif.screenshot_ratios`: a ratio match only counts when the file **also carries no EXIF camera
  make**. 4:3 and 16:9 are camera ratios as much as screen ratios, so the ratio alone proves
  nothing. A `exif.filename_patterns` match is enough on its own.
- `zeroshot.quantiles`: four cut points giving the five buckets, applied to **rank**. Ratings are
  therefore relative: the bottom `quantiles[0]` share gets 1 star whatever it holds, and the pool
  size is set here rather than by how many good photos exist. The top two cuts move together,
  because the household bump promotes a share of the 4 star bucket into 5:
  `5 star share = (1 - cut4) + household_face_rate * (cut4 - cut3)`.
- `pool.min_rating`: 5 by default. At 4 the pool took 39% of a real 18,000 asset library.
- `ridge.min_labels`: how many corrections before the learned model takes over from the prompts.
- `ml.model_name`: leave empty to read it from the server. Set it when the API key is not allowed
  `adminConfig.read`.

### Secrets, all from the environment

| Variable | Notes |
|---|---|
| `IMMICH_URL`, `IMMICH_API_KEY` | See the permissions below. |
| `IMMICH_ML_URL` | The `immich-machine-learning` container. LAN only, never exposed. |
| `PGHOST` `PGPORT` `PGUSER` `PGPASSWORD` `PGDATABASE` | A **read-only** role on the Immich DB. |
| `STATE_DIR` | Where `state.sqlite` lives. `/data/state` in the container. |

The Postgres role only ever needs to read `smart_search`. Create it from a root DSM task, since
there is no SSH, generating the password in place so it never passes through anything else:

```bash
cd /volume1/docker/immich-auto-rating && PGU=$(docker exec immich_postgres printenv POSTGRES_USER) && PGD=$(docker exec immich_postgres printenv POSTGRES_DB) && PW=$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n') && docker exec -i immich_postgres psql -U "$PGU" -d "$PGD" -v ON_ERROR_STOP=1 <<SQL && printf 'PGPASSWORD=%s\n' "$PW" >> .env && chmod 600 .env
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'immich_ro') THEN CREATE ROLE immich_ro LOGIN; END IF;
END \$\$;
ALTER ROLE immich_ro PASSWORD '$PW';
GRANT CONNECT ON DATABASE "$PGD" TO immich_ro;
GRANT USAGE ON SCHEMA public TO immich_ro;
GRANT SELECT ON smart_search TO immich_ro;
SQL
```

It grants `SELECT` on one table and nothing else. `smart_search` holds asset ids and CLIP vectors,
no photo content and no metadata.

### API key permissions

Scope the key to exactly these eight. The first four are the obvious ones; the rest are what the
pool album and the model lookup actually need:

    asset.read  asset.update  album.read  albumAsset.create
    album.create  albumAsset.delete  person.read  adminConfig.read

`adminConfig.read` is admin-level and only buys the CLIP model name. To keep it off a scheduled
key, set `ml.model_name` in `config.toml` instead and drop it from the list.

## The pool album

After writing ratings, `apply` reconciles the album named by `pool.album`, creating it if missing.
Assets at or above `pool.min_rating` are added, assets that dropped below are removed. Anything the
run did not score is left alone, so an album is never emptied by a partial run.

## State

One SQLite file, `$STATE_DIR/state.sqlite`, table `assets(asset_id, rating_written, rated_at,
frozen, label, model_version)`. It is the memory of every correction you have ever made. **Back it
up.** Losing it does not corrupt anything, but the next run re-imports whatever ratings are on the
assets as labels and starts over from there.

Runs are idempotent and resumable: writes are recorded per batch, a frozen asset is never written
again, and no asset is rated twice in one run.

## Docker on the NAS

Everything lives under `/volume1/docker/immich-auto-rating`:

    /volume1/docker/immich-auto-rating/
      docker-compose.yml
      .env                  # the secrets above
      data/
        config.toml
        state/state.sqlite  # created on the first run

Paths in `docker-compose.yml` are absolute and the secrets come in through `env_file`, so the task
behaves the same whatever directory it runs from. `docker compose` only reads a `.env` sitting in
its own project directory, which is the trap this avoids.

The container joins Immich's own compose network so `immich-machine-learning` and the database
resolve by name. On this NAS that network is **`immich-photos_default`**, confirmed 2026-09-17.
Note there is also an unrelated `immich_default` on the same host; joining that one would resolve
nothing. `docker network ls` after an Immich stack rename is the place to re-check.

The image runs as `node`, not root, on `node:24-alpine` with `tini` as PID 1. Nothing is scheduled
inside it: one invocation, one run, exit.

### Why `/volume1/docker`, and not any share you like

The container runs as the `node` user, uid 1000, so the mount must be readable and writable by uid
1000. Which share you put it on decides whether that is even possible.

`/volume1/tools` and most shares created through the DSM UI are **ACL-only**: `ls -la` shows mode
`000` with a `+`, and a single ACL entry granting `group:administrators`. POSIX permissions there
are inert. `chown` reports success and changes nothing, `synoacltool` refuses to grant a uid with
no DSM account behind it, and a non-root container simply cannot read the directory. A container
running as root does not notice any of this, which is why other tools on the NAS work there.

`/volume1/docker` is `dr-xr-xr-x` with real POSIX bits, so `chown` and `chmod` both work. What it
does **not** give you is a write bit: new directories inherit mode `555`, owner included. So the
mount needs `chown` **and** `chmod`, and it needs them again after every File Station upload, since
uploads arrive owned by your DSM user. Both commands below start with that pair, so there is no
one-time setup to forget.

### DSM Task Scheduler

Control Panel, Task Scheduler, Create, Scheduled Task, User-defined script. Run as `root`, monthly,
and set the user-defined script to:

The task must run as root. DSM's Docker socket is root-owned and there is no usable `docker` group,
so a non-root task gets `permission denied` on every `docker` call. This costs nothing in practice:
anyone who can reach the Docker socket can mount the host into a privileged container and become
root anyway. The user that matters is the container's own, and that is `node`, not root.

```bash
cd /volume1/docker/immich-auto-rating && chown -R 1000:1000 data && chmod -R u+rwX data && /usr/local/bin/docker compose pull -q rate && /usr/local/bin/docker compose run --rm rate apply
```

The `pull` keeps the NAS on the published `linux/amd64` image. Tick "send run details by email" on
"abnormal termination" and the non-zero exit on a partial failure reaches you.

To look at a run without writing anything, swap the verb:

```bash
cd /volume1/docker/immich-auto-rating && chown -R 1000:1000 data && chmod -R u+rwX data && /usr/local/bin/docker compose run --rm rate report
```

## Releases

GitHub Actions builds and publishes the image. `.github/workflows/ci.yml` runs typecheck, tests and
build on every push and PR. `.github/workflows/image.yml` pushes `linux/amd64` to
`ghcr.io/<owner>/immich-auto-rating`:

| Trigger | Tags published |
|---|---|
| push to `main` | `latest` |
| tag `v*` | `latest` and the version, e.g. `0.2.0` |
| manual dispatch | `latest`, plus a version if you type one |

Docs, `docs/` and `scripts/` are excluded from the image trigger, since they change nothing about
what ships. The NAS pulls `latest` before every run, so merging to `main` is what reaches it; tag
when you want a version you can pin or roll back to.

    git tag v0.2.0 && git push --tags

## Development

    npm test          # vitest, no network, fixtures only
    npm run typecheck
    npm run build     # tsdown, one ESM bundle at dist/cli.js

Tests never touch Immich, Postgres or the ML container. API responses, embeddings and database rows
are fixtures; `test/fixtures/config.toml` is the tests' own copy of the config, never the real one.
