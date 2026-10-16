#!/bin/sh
# Build the image, start Compose, and require HTTP 200 from /api/setup/health.
set -eu
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "self-host/.env is missing. Copy .env.example and set the values." >&2
  exit 1
fi

port="${LLLL_PUBLISH_PORT:-8080}"

if ! docker compose up -d --build; then
  docker compose logs --no-color >&2 || true
  exit 1
fi

deadline=$(( $(date +%s) + 600 ))
until docker compose logs llll 2>&1 | grep -q "migrations apply .* finished"; do
  state=$(docker compose ps --all --format '{{.Service}} {{.State}}' | awk '$1 == "llll" { print $2; exit }')
  if [ "$state" = "exited" ] || [ "$state" = "dead" ]; then
    echo "llll exited before migrations finished" >&2
    docker compose logs --no-color >&2 || true
    exit 1
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "migrations did not finish" >&2
    docker compose logs --no-color >&2 || true
    exit 1
  fi
  sleep 5
done

body="${TMPDIR:-/tmp}/llll-health.json"
code=$(curl -sS -o "$body" -w '%{http_code}' "http://127.0.0.1:${port}/api/setup/health" || true)
echo "health HTTP ${code}"
if [ "$code" != "200" ]; then
  cat "$body" >&2 || true
  docker compose logs --no-color >&2 || true
  exit 1
fi
