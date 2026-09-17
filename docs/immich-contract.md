# Immich contract

Facts this CLI depends on, and how each was established. Re-check the `live` rows after an
Immich upgrade; they are the ones a release can move.

Target server: `https://photos.ledoux.cloud`, **Immich 3.2.0** (`GET /api/server/version` ->
`{"major":3,"minor":2,"patch":0,"prerelease":null}`, read 2026-09-17).

Provenance tags:

- `live`: read from the running server on 2026-09-17.
- `spec@3.2.0`: `open-api/immich-openapi-specs.json` at tag `v3.2.0`, the spec that server generates.
- `src@3.2.0`: Immich source at tag `v3.2.0`.
- `UNVERIFIED`: could not be probed from this machine. Confirm before trusting.

## 1. Rating range on `PUT /api/assets/{id}`

`spec@3.2.0`, `UpdateAssetDto.rating`:

    "rating": { "type":"integer", "minimum":-1, "maximum":5, "nullable":true,
                "description":"Rating in range [1-5] (starred), -1 (rejected), or null (unrated)" }

The v3 history entry is explicit: **"Using 0 as a rating is no longer valid."** So on this server:

| Value | Meaning |
|---|---|
| `null` | unrated |
| `-1` | rejected |
| `1`..`5` | starred |
| `0` | **rejected by validation**, do not send |

Consequences for us:

- "Unrated" is `null`, not `0`. The state DB stores `rating_written` as `NULL` for never-written.
- First-run label import keys off `rating != null`, not `rating != 0`.
- We never emit `-1`. Receipts and screenshots go to `1`, per the brief. `-1` stays reserved for
  the user's own hand rejections and, like any hand edit, freezes the asset.

### Bulk write, preferred over the per-asset call

`spec@3.2.0`: `PUT /api/assets` (`operationId: updateAssets`, permission `asset.update`) takes
`AssetBulkUpdateDto` = `{ ids: uuid[], rating?: ... }`. One request per rating bucket beats
N requests at concurrency 4. `PUT /api/assets/{id}` (`updateAsset`) stays as the fallback and as
the retry path for a bulk call that partly failed.

## 2. The `rating` search filter: exact, and deprecated

Two shapes exist in 3.2.0 and this matters.

**Old flat field**, on `MetadataSearchDto`, `RandomSearchDto`, `SmartSearchDto`,
`StatisticsSearchDto` (`spec@3.2.0`):

    "rating": { "type":"integer", "minimum":1, "maximum":5, "nullable":true, "deprecated":true,
                "description":"Filter by rating [1-5], or null for unrated" }

It is **exact match**, not a range, and its `x-immich-history` marks it `Deprecated` at exactly
`v3.2.0`. `-1` is no longer accepted there either. Do not build on it.

**New filter DSL**, `filter: SearchFilter` on the same four DTOs (`spec@3.2.0`). `SearchFilter.rating`
is a `NumberFilterNullable`:

    { eq?: number|null, ne?: number|null, gt?, gte?, lt?, lte?, in?: number[], notIn?: number[] }

So ranges are supported, and `pool_min_rating` is one call:

    POST /api/search/metadata
    { "filter": { "rating": { "gte": 4 }, "type": { "eq": "IMAGE" },
                  "visibility": { "eq": "timeline" }, "trashedAt": { "eq": null } },
      "withExif": true, "withPeople": true, "size": 1000 }

Every other flat field (`type`, `visibility`, `takenAfter`, `personIds`, `isFavorite`, `make`, ...)
is deprecated the same way and has a `filter` equivalent. We use `filter` throughout.

Operator shapes we rely on (`spec@3.2.0`):

- `BoolFilter` = `{ eq: boolean }`, `eq` required.
- `EnumFilterAssetVisibility` = `{ eq?|ne?|in?|notIn? }` over `archive|timeline|hidden|locked`.
- `StringPatternFilter` = `{ eq?|ne?|in?|notIn?|like?|notLike?|startsWith?|endsWith? }`.
- `IdsFilter` = `{ any?|all?|none?: uuid[] }`.
- `DateFilterNullable` = `{ eq?|ne?|gt?|gte?|lt?|lte? }`, ISO datetimes with offset or `Z`.

### Pagination changed too

`MetadataSearchDto.page` is deprecated. The live shape is `cursor` in, `nextCursor` out:
`SearchAssetResponseDto` requires `count`, `facets`, `items`, `nextCursor`, `nextPage`, `total`,
with `nextPage` deprecated. Page by feeding `nextCursor` back as `cursor` until it is null.

`POST /api/search/random` has **no** `cursor` or `page`, only `size`. It is a sampler, not a
pager, so candidate enumeration uses `/search/metadata`.

## 3. Candidate shape

`AssetResponseDto` (`spec@3.2.0`) carries `id`, `type`, `visibility`, `isTrashed`, `isArchived`,
`isFavorite`, `localDateTime`, `originalFileName`, `width`, `height`, `exifInfo`, `people`, `stack`.

`stack` is `AssetStackResponseDto | null` = `{ id, primaryAssetId, assetCount }`, all required.
So the principal test is self-contained on the asset:

    asset.stack == null || asset.stack.primaryAssetId === asset.id

Note `visibility` is the enum (`timeline` is what we want); `isArchived` is the legacy mirror of
`visibility === 'archive'`. Filter on `visibility`, keep `isArchived` only as a belt-and-braces
assertion in tests.

`withStacked` on the search DTOs is **not** the primary-only switch. In the sibling planner it was
found to drop whole stacks rather than fold them; `stack.primaryAssetId` is the reliable source.

## 4. CLIP embeddings in Postgres

`src@3.2.0`, `server/src/schema/tables/smart-search.table.ts`:

    @Table({ name: 'smart_search' })
    @Index({ name: 'clip_index', using: 'hnsw', expression: `embedding vector_cosine_ops`,
             with: `ef_construction = 300, m = 16` })
    class SmartSearchTable {
      @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', primary: true }) assetId!: string;
      @Column({ type: 'vector', length: 512, storage: 'external' }) embedding!: string;
    }

So: table `smart_search`, PK `"assetId"` (quoted camelCase, Immich convention), column `embedding`,
pgvector `vector(512)`, cosine index. The read is:

    SELECT "assetId", embedding::text FROM smart_search WHERE "assetId" = ANY($1::uuid[])

`embedding::text` gives pgvector's `[0.1,-0.2,...]` literal, which parses without a pgvector client
binding. **UNVERIFIED**: the exact column quoting and the declared length on *this* database.
The 512 above is the checked-in default; Immich rewrites the column when the CLIP model changes,
so a server on a 768-dim model has `vector(768)` here. The CLI reads the dimension from the first
row rather than assuming, and asserts every later row matches.

Vectors are **not** guaranteed L2-normalised in storage. We normalise on read.

## 5. `immich-machine-learning` `/predict`

`src@3.2.0`, `machine-learning/immich_ml/main.py`. `POST /predict`, `multipart/form-data`:

- `entries`: a JSON **string** (not a JSON body), shape
  `{ "<task>": { "<type>": { "modelName": string, "options"?: object } } }`
- plus exactly one of `text` (form field) or `image` (file bytes). Neither, or both absent, is a 400.

`ModelTask` = `clip` | `facial-recognition` | `ocr`. `ModelType` = `visual` | `textual` |
`detection` | `recognition` (`src@3.2.0`, `immich_ml/schemas.py`).

So the textual call we need is:

    POST {IMMICH_ML_URL}/predict
    multipart: entries='{"clip":{"textual":{"modelName":"ViT-B-32__openai"}}}'
               text='a photo of a paper receipt'

Response is `{ "<task>": <output> }`, keyed by task, so `{"clip": ...}`.

**The gotcha**: `BaseCLIPTextualEncoder._predict` returns `serialize_np_array(res)`, and
`serialize_np_array` is `orjson.dumps(arr).decode()`. The value under `"clip"` is therefore a
**JSON string** holding the array, not an array. It needs a second `JSON.parse`. It is also the raw
ONNX output with **no normalisation applied**, so we L2-normalise it ourselves before any cosine.

`GET /ping` on the same container answers `pong` (text/plain) and is the health check.

## 6. The CLIP model name

`src@3.2.0`, `server/src/dtos/config.dto.ts` default:

    clip: { enabled: true, modelName: 'ViT-B-32__openai' }

Naming is `arch__pretrained` with a **double** underscore. `server/src/constants.ts` carries
`CLIP_MODEL_INFO` with the dimension per model (`ViT-B-32__openai` -> 512, the nllb-clip-large
family -> 1152, and so on).

It must be read from the server, not defaulted: the model is admin-configurable and a wrong name
makes the ML container load a second model and silently embed into a different space from the one
`smart_search` holds.

    GET /api/admin/config   -> machineLearning.clip.modelName   (permission adminConfig.read)

`GET /api/system-config` is the same payload but is **deprecated** in 3.2.0. Use `/admin/config`.

**UNVERIFIED**: the model actually configured on this server. The CLI reads it at startup, compares
the `CLIP_MODEL_INFO` dimension against the width of the vectors coming out of `smart_search`, and
refuses the run on a mismatch rather than scoring against a mixed space.

## 7. Album endpoints for the pool

`spec@3.2.0`:

- `GET /api/albums` -> `AlbumResponseDto[]` (`album.read`). Carries `assetCount`, **not** assets.
- `POST /api/albums` (`album.create`).
- `PUT /api/albums/{id}/assets` (`albumAsset.create`), `DELETE /api/albums/{id}/assets`
  (`albumAsset.delete`).

`GET /api/albums/{id}` does not return a usable asset list. Read an album's members the same way the
sibling planner does, with `POST /api/search/metadata` and `filter.albumIds.any = [id]`.

## 8. API key permissions

The brief asked for `asset.read`, `asset.update`, `album.read`, `albumAsset.create`. That set is
**short by four** for what this CLI does (`spec@3.2.0`, `x-immich-permission` per operation):

| Permission | Needed by |
|---|---|
| `asset.read` | `POST /search/metadata` |
| `asset.update` | `PUT /assets`, `PUT /assets/{id}` |
| `album.read` | `GET /albums` |
| `albumAsset.create` | `PUT /albums/{id}/assets` |
| `album.create` | creating the pool album when it is missing |
| `albumAsset.delete` | dropping assets that fell below `pool_min_rating` |
| `person.read` | resolving `household.persons` names to ids via `GET /people` |
| `adminConfig.read` | reading `machineLearning.clip.modelName` |

`adminConfig.read` is an admin permission. If it is not wanted on a scheduled key, set
`ml.model_name` in `config.toml` and the CLI skips the lookup, keeping the dimension check.

## 9. Worth knowing, not yet used

`GET /api/server/features` on this server reports `"ocr": true`, and 3.2.0 exposes
`GET /api/assets/{id}/ocr` plus a `filter.ocr` (`StringSimilarityFilter` = `{ matches: string }`)
on every search DTO. Receipts, screenshots and documents are exactly the assets that carry dense
OCR text, so this is a stronger signal than either CLIP prompt or aspect ratio. Out of scope for
this build; a candidate feature for the ridge model later.

## Open items

Each needs a credential or LAN access this machine does not have.

1. `smart_search` column quoting and `vector` length on this database. Needs `PG*`.
2. `machineLearning.clip.modelName` on this server. Needs an admin key.
3. A live `/predict` round trip confirming the double-encoded array. Needs `IMMICH_ML_URL`.
4. Live confirmation that `filter.rating.gte` behaves as documented. Needs any working key.
