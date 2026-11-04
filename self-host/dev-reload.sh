#!/bin/sh
# Development only. Publish completed builds, never half-written Rollup output.
set -eu
previous=$LLLL_DEV_DEPLOYED_BUILD
while sleep 1; do
  current=$(cat /opt/llll/.output/.build.json 2>/dev/null || true)
  if [ -z "$current" ] || [ "$current" = "$previous" ]; then continue; fi
  previous=$current
  build_directory=$(printf '%s' "$current" | jq -r '.directory')
  case "$build_directory" in build-[0-9]*) ;; *) continue ;; esac
  tmp=$(mktemp)
  jq --arg dir ".output/$build_directory" \
    '.main=($dir+"/server/index.mjs") | .assets.directory=($dir+"/public")' "$CELLD_CONFIG" > "$tmp"
  mv "$tmp" "$CELLD_CONFIG"
  echo 'llll: applying local migrations and reloading backend'
  if celld d1 migrations apply "$DATABASE_NAME" "$CELLD_CONFIG" \
    --bucket "$CELLD_BUCKET" --endpoint "$S3_ENDPOINT" --region "$AWS_REGION" \
    && celld deploy "$CELLD_CONFIG" \
      --bucket "$CELLD_BUCKET" --endpoint "$S3_ENDPOINT" --region "$AWS_REGION" \
    && curl -fsS -X POST "http://${CELLD_INTERNAL_LISTEN}/reload" >/dev/null; then
    echo 'llll: backend reloaded'
  else
    echo 'llll: backend reload failed; fix the source and save again' >&2
  fi
done
