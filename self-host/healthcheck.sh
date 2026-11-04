#!/bin/sh
# Stay unhealthy until celld has recorded D1 migrations. Curling the app before
# that runs the bundled schema bootstrap and the migration apply then fails
# with "table already exists".
set -eu

CELLD_WATCH="${CELLD_WATCH:-/var/lib/llll/celld}"
if [ ! -f "${CELLD_WATCH}/.migrations-applied" ]; then
  exit 1
fi

path=/api/setup/health
# HTTP 200 also carries setup diagnostics when the database is unavailable.
# An unclaimed Owner (ready=false) is healthy once the schema is usable.
# Capture curl separately: POSIX sh has no pipefail, and a failed transfer must
# not pass merely because it returned a parseable partial body.
body=$(curl -fsS --connect-timeout 1 --max-time 3 "http://127.0.0.1:${LLLL_PORT:-8080}${path}") || exit 1
printf '%s' "$body" | jq -es 'length == 1 and (.[0] | .ok == true and .migrated == true)' >/dev/null 2>&1
