#!/bin/sh
# Build and verify the restricted runtime and database readiness.
set -eu
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "self-host/.env is missing. Copy .env.example and set the values." >&2
  exit 1
fi

port="${LLLL_PUBLISH_PORT:-8080}"
compose() { docker compose -f docker-compose.yml -f compose.build.yml "$@"; }

if ! compose up -d --build; then
  compose logs --no-color >&2 || true
  exit 1
fi

deadline=$(( $(date +%s) + 600 ))
until compose logs llll 2>&1 | grep -q "migrations apply .* finished"; do
  state=$(compose ps --all --format '{{.Service}} {{.State}}' | awk '$1 == "llll" { print $2; exit }')
  if [ "$state" = "exited" ] || [ "$state" = "dead" ]; then
    echo "llll exited before migrations finished" >&2
    compose logs --no-color >&2 || true
    exit 1
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "migrations did not finish" >&2
    compose logs --no-color >&2 || true
    exit 1
  fi
  sleep 5
done

body="${TMPDIR:-/tmp}/llll-health.json"
code=$(curl -sS -o "$body" -w '%{http_code}' "http://127.0.0.1:${port}/api/setup/health" || true)
echo "health HTTP ${code}"
if [ "$code" != "200" ] || ! jq -e '.ok == true and .migrated == true' "$body" >/dev/null; then
  cat "$body" >&2 || true
  compose logs --no-color >&2 || true
  exit 1
fi

compose exec -T llll /usr/local/bin/llll-healthcheck
compose exec -T llll sh -c '
  test "$(id -u)" = 10001 &&
  grep -Eq "^CapEff:[[:space:]]+0+$" /proc/self/status &&
  grep -Eq "^NoNewPrivs:[[:space:]]+1$" /proc/self/status &&
  test -w /tmp && test -w /var/lib/llll/celld &&
  test ! -w /opt/llll && test ! -w /usr/local/bin
'
# Even root inside the container cannot write the application filesystem.
if compose exec -T --user 0 llll sh -c 'touch /opt/llll/.readonly-probe' 2>/dev/null; then
  echo 'Application filesystem is unexpectedly writable' >&2
  exit 1
fi
echo 'PASS: database readiness, non-root, read-only application, no capabilities or privilege escalation'
