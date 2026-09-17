#!/bin/sh
# One-off probe for the open items in docs/immich-contract.md. Paste into a DSM user-defined
# script task, run once, then read the log. Writes nothing to Immich and prints no secrets.
DOCKER=/usr/local/bin/docker

# The env file holding IMMICH_API_KEY. Override with ENV_FILE=..., else the first of these that
# exists wins. The log lands beside it, in a directory that demonstrably already exists.
for candidate in \
  "$ENV_FILE" \
  /volume1/tools/immich-auto-rating/.env \
  /volume1/docker/immich-auto-rating/.env
do
  [ -n "$candidate" ] && [ -f "$candidate" ] && ENV_FILE="$candidate" && break
done

BASE=${OUT:-$(dirname "${ENV_FILE:-/volume1/tools/immich-auto-rating/.env}")}
LOG="$BASE/probe-$(date +%Y%m%d-%H%M%S).txt"

mkdir -p "$BASE"
exec > "$LOG" 2>&1
echo "immich-auto-rating probe, $(date -Is)"
echo "env file: ${ENV_FILE:-none found}"

say() { echo; echo "=== $1 ==="; }

say "containers"
$DOCKER ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}'

say "networks"
$DOCKER network ls --format '{{.Name}}'

PG=$($DOCKER ps --format '{{.Names}}' | grep -iE 'postgres|database|immich[-_]db' | head -1)
ML=$($DOCKER ps --format '{{.Names}}' | grep -iE 'machine[-_]learning' | head -1)
NET=$($DOCKER inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$ML" 2>/dev/null | head -1)
echo "postgres=$PG  ml=$ML  network=$NET"

# 1. smart_search shape: the table, the declared vector width, and the width actually stored.
say "1. smart_search"
if [ -n "$PG" ]; then
  $DOCKER exec "$PG" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "\d smart_search"'
  $DOCKER exec "$PG" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -c "SELECT format_type(a.atttypid, a.atttypmod) AS declared, count(*) OVER () FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relname = '"'"'smart_search'"'"' AND a.attname = '"'"'embedding'"'"';"'
  $DOCKER exec "$PG" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -c "SELECT vector_dims(embedding) AS stored_width, count(*) FROM smart_search GROUP BY 1;"'
else
  echo "SKIP: no postgres container matched"
fi

# 2. The CLIP model Immich is configured with. Needs a key with adminConfig.read.
say "2. clip model"
if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
fi
if [ -n "$IMMICH_API_KEY" ] && [ -n "$IMMICH_URL" ]; then
  curl -sS -H "x-api-key: $IMMICH_API_KEY" \
    "$IMMICH_URL/api/admin/config" \
    | sed -n 's/.*"clip":{\([^}]*\)}.*/clip:{\1}/p'
  echo "(empty above means the key lacks adminConfig.read, or the shape moved)"
else
  echo "SKIP: need IMMICH_URL and IMMICH_API_KEY in /volume1/tools/immich-auto-rating/.env"
fi

# 3. The /predict contract: is the clip value a JSON string, and how wide.
say "3. ml predict"
if [ -n "$NET" ]; then
  MODEL=$($DOCKER exec "$PG" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -A -c "SELECT value FROM system_metadata WHERE key = '"'"'system-config'"'"';"' 2>/dev/null \
    | sed -n 's/.*"clip":{[^}]*"modelName":"\([^"]*\)".*/\1/p')
  [ -z "$MODEL" ] && MODEL=ViT-B-32__openai
  echo "asking for modelName=$MODEL"
  $DOCKER run --rm --network "$NET" curlimages/curl:latest -sS \
    -F "entries={\"clip\":{\"textual\":{\"modelName\":\"$MODEL\"}}}" \
    -F 'text=a photo of a paper receipt' \
    "http://$ML:3003/predict" | cut -c1-240
  echo
  echo "(a leading \"clip\":\" with a quote means double encoded, as the contract expects)"
else
  echo "SKIP: could not resolve the ML container network"
fi

# 4. The search filter DSL: does filter.rating take a range, and does the candidate filter work.
# curl only, so this one answers even when the task is not running as root.
say "4. search filter DSL"
if [ -n "$IMMICH_API_KEY" ] && [ -n "$IMMICH_URL" ]; then
  URL="$IMMICH_URL/api/search/metadata"
  probe() {
    echo "-- $1"
    code=$(curl -sS -o /tmp/probe4.json -w '%{http_code}' -X POST "$URL" \
      -H "x-api-key: $IMMICH_API_KEY" -H 'content-type: application/json' -d "$2")
    echo "HTTP $code"
    if [ "$code" = "200" ]; then
      tr '{},' '\n\n\n' < /tmp/probe4.json | grep -E '"(total|count|nextCursor)"' | head -8
    else
      head -c 300 /tmp/probe4.json; echo
    fi
  }
  probe "candidate filter (IMAGE, timeline, untrashed)" \
    '{"filter":{"type":{"eq":"IMAGE"},"visibility":{"eq":"timeline"},"trashedAt":{"eq":null}},"withExif":true,"withPeople":true,"size":1}'
  probe "rating gte 4 (the pool query)" '{"filter":{"rating":{"gte":4}},"size":1}'
  probe "rating eq null (unrated)" '{"filter":{"rating":{"eq":null}},"size":1}'
  probe "rating eq 0 (expected to fail, 0 is invalid on v3)" '{"filter":{"rating":{"eq":0}},"size":1}'
  rm -f /tmp/probe4.json
  echo "(the first total is albums, the second is assets)"
else
  echo "SKIP: need IMMICH_URL and IMMICH_API_KEY"
fi

say "done"
echo "log: $LOG"
