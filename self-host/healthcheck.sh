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
curl -fsS "http://127.0.0.1:${LLLL_PORT:-8080}${path}"
