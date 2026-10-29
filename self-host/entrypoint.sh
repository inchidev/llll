#!/bin/sh
# Render wrangler.celld.local.json from the environment, deploy it, apply D1
# migrations, and run one celld node. celld has no secrets store: `celld deploy`
# writes `vars` into the fleet bucket as plaintext. A self-fence exits this
# process; the container restart policy starts it again.
set -eu

TEMPLATE="${CELLD_TEMPLATE:-/opt/llll/wrangler.celld.json}"
CONFIG="${CELLD_CONFIG:-$(dirname "$TEMPLATE")/wrangler.celld.local.json}"
CELLD_BUCKET="${CELLD_BUCKET:-s3://cells}"
S3_ENDPOINT="${S3_ENDPOINT:-http://rustfs:9000}"
AWS_REGION="${AWS_REGION:-us-east-1}"
CELLD_LISTEN="${CELLD_LISTEN:-0.0.0.0:8080}"
CELLD_INTERNAL_LISTEN="${CELLD_INTERNAL_LISTEN:-127.0.0.1:8081}"
CELLD_ADVERTISE="${CELLD_ADVERTISE:-127.0.0.1:8081}"
CELLD_WATCH="${CELLD_WATCH:-/var/lib/llll/celld}"
CELLD_RESTART_DELAY="${CELLD_RESTART_DELAY:-15}"

export AWS_REGION S3_ENDPOINT CELLD_WATCH
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-}"

celld_pid=
reload_pid=

stop_celld() {
  if [ -n "$reload_pid" ]; then kill -TERM "$reload_pid" 2>/dev/null || true; fi
  if [ -n "$celld_pid" ]; then
    kill -TERM "$celld_pid" 2>/dev/null || true
  fi
}

trap 'stop_celld; if [ -n "$celld_pid" ]; then wait "$celld_pid" || true; fi; exit 0' TERM INT

fail() {
  echo "llll: $*" >&2
  stop_celld
  if [ -n "$celld_pid" ]; then
    wait "$celld_pid" || true
  fi
  exit 1
}

# Coolify fills SERVICE_* when the plain names were not set.
if [ -z "${PUBLIC_ORIGIN:-}" ] && [ -n "${SERVICE_URL_LLLL_8080:-}" ]; then
  PUBLIC_ORIGIN=$SERVICE_URL_LLLL_8080
fi
if [ -z "${AUTH_SECRET:-}" ] && [ -n "${SERVICE_PASSWORD_64_AUTHSECRET:-}" ]; then
  AUTH_SECRET=$SERVICE_PASSWORD_64_AUTHSECRET
fi
if [ -z "${SETUP_TOKEN:-}" ] && [ -n "${SERVICE_PASSWORD_64_SETUPTOKEN:-}" ]; then
  SETUP_TOKEN=$SERVICE_PASSWORD_64_SETUPTOKEN
fi
PUBLIC_ORIGIN=${PUBLIC_ORIGIN:-}
PUBLIC_ORIGIN=${PUBLIC_ORIGIN%/}
# The _8080 suffix tells Coolify's proxy which container port to route to; the
# browser reaches the Server on the proxy's own port, never on :8080.
if [ -n "${SERVICE_URL_LLLL_8080:-}" ] && [ "$PUBLIC_ORIGIN" = "${SERVICE_URL_LLLL_8080%/}" ]; then
  PUBLIC_ORIGIN=${PUBLIC_ORIGIN%:8080}
fi
export PUBLIC_ORIGIN AUTH_SECRET="${AUTH_SECRET:-}" SETUP_TOKEN="${SETUP_TOKEN:-}"

require_set() {
  if [ -z "$(printenv "$1" || true)" ]; then
    fail "set $1"
  fi
}

require_min() {
  value=$(printenv "$1" || true)
  if [ -z "$value" ]; then
    return 0
  fi
  if [ "${#value}" -lt "$2" ]; then
    fail "$1 must be at least $2 characters"
  fi
}

require_set PUBLIC_ORIGIN
require_set AUTH_SECRET
require_set ADMIN_EMAIL
require_set SETUP_TOKEN
require_set AWS_ACCESS_KEY_ID
require_set AWS_SECRET_ACCESS_KEY
require_min AUTH_SECRET 32
require_min ADMIN_PASSWORD 12
require_min SETUP_TOKEN 32
require_min INBOUND_EMAIL_SECRET 32
require_min POSTMARK_INBOUND_SECRET 32
require_min MAILGUN_WEBHOOK_SIGNING_KEY 32
require_min CLOUDFLARE_API_TOKEN 32

account_id=$(printenv CLOUDFLARE_ACCOUNT_ID || true)
if [ -n "$account_id" ] && ! printf '%s' "$account_id" | grep -Eq '^[0-9a-fA-F]{32}$'; then
  fail "CLOUDFLARE_ACCOUNT_ID must be 32 hex characters"
fi

case "$ADMIN_EMAIL" in
  *@*) ;;
  *) fail "ADMIN_EMAIL must look like an email address" ;;
esac

if [ ! -f "$TEMPLATE" ]; then
  fail "missing $TEMPLATE"
fi

umask 077
cp "$TEMPLATE" "$CONFIG"

put_var() {
  key=$1
  value=$(printenv "$key" || true)
  if [ -z "$value" ]; then
    return 0
  fi
  tmp=$(mktemp)
  jq --arg k "$key" --arg v "$value" '.vars[$k]=$v' "$CONFIG" > "$tmp"
  mv "$tmp" "$CONFIG"
}

put_var PUBLIC_ORIGIN
put_var LLLL_ORIGINS
put_var SERVER_ID
put_var AUTH_SECRET
put_var ADMIN_EMAIL
# With ADMIN_PASSWORD the first start creates the Owner and skips the setup claim.
if [ -n "${ADMIN_PASSWORD:-}" ]; then
  export ADMIN_SERVER="${ADMIN_SERVER:-${APP_NAME:-L4}}"
  put_var ADMIN_PASSWORD
  put_var ADMIN_NAME
  put_var ADMIN_SERVER
fi
put_var SETUP_TOKEN
put_var CLOUDFLARE_ACCOUNT_ID
put_var CLOUDFLARE_API_TOKEN
put_var AI_BASE_URL
put_var AI_API_KEY
put_var AI_MODEL
put_var AGENT_RUNNER_URL
put_var AGENT_RUNNER_TOKEN
put_var AGENT_CALLBACK_ORIGIN
put_var EXA_API_KEY
put_var GITHUB_AGENT_APP_ID
put_var GITHUB_AGENT_APP_PRIVATE_KEY
put_var MAIL_GATEWAY_URL
put_var MAIL_GATEWAY_TOKEN
put_var SMTP_GATEWAY_URL
put_var SMTP_GATEWAY_TOKEN
put_var LLLL_EMAIL_DOMAINS
put_var MAIL_APP_HOSTNAME
put_var MAIL_DEFAULT_LOCAL_PART
put_var EMAIL_FROM
put_var EMAIL_FROM_NAME
put_var INBOUND_EMAIL_SECRET
put_var POSTMARK_INBOUND_SECRET
put_var MAILGUN_WEBHOOK_SIGNING_KEY
put_var SES_SNS_TOPIC_ARN
put_var BROWSER_CDP_URL
put_var SETUP_TOKEN
put_var EMBED_ORIGINS
put_var TELEGRAM_TRUSTED_BOT_ID
put_var TELEGRAM_BOT_TOKEN

tmp=$(mktemp)
jq '.vars.LLLL_RUNTIME="celld" | .vars.AUTH_REGISTRATION_MODE="invite_only"' "$CONFIG" > "$tmp"
mv "$tmp" "$CONFIG"

if [ -n "${DATABASE_NAME:-}" ]; then
  tmp=$(mktemp)
  jq --arg name "$DATABASE_NAME" '.d1_databases[0].database_name=$name' "$CONFIG" > "$tmp"
  mv "$tmp" "$CONFIG"
fi

chmod 600 "$CONFIG"
if [ "${LLLL_DEV_RELOAD:-false}" = true ]; then
  LLLL_DEV_DEPLOYED_BUILD=$(cat /opt/llll/.output/.build.json)
  build_directory=$(printf '%s' "$LLLL_DEV_DEPLOYED_BUILD" | jq -r '.directory')
  case "$build_directory" in build-[0-9]*) ;; *) fail "missing completed backend build" ;; esac
  tmp=$(mktemp)
  jq --arg dir ".output/$build_directory" \
    '.main=($dir+"/server/index.mjs") | .assets.directory=($dir+"/public")' "$CONFIG" > "$tmp"
  mv "$tmp" "$CONFIG"
  export LLLL_DEV_DEPLOYED_BUILD
fi
DATABASE_NAME=$(jq -r '.d1_databases[0].database_name' "$CONFIG")
if [ -z "$DATABASE_NAME" ] || [ "$DATABASE_NAME" = "null" ]; then
  fail "wrangler config has no d1 database_name"
fi

# Migrations only go forward. The data volume records the newest release that
# migrated it, and an older image stops here before it deploys over that schema.
# Development images carry no VERSION and skip the check.
IMAGE_VERSION=$(cat /opt/llll/VERSION 2>/dev/null || true)
DATA_VERSION_FILE="${CELLD_WATCH}/.llll-version"
version_core() { printf '%s' "${1%%-*}"; }
version_older() {
  [ "$(version_core "$1")" != "$(version_core "$2")" ] \
    && [ "$(printf '%s\n%s\n' "$(version_core "$1")" "$(version_core "$2")" | sort -V | head -n 1)" = "$(version_core "$1")" ]
}
if [ -n "$IMAGE_VERSION" ] && [ -f "$DATA_VERSION_FILE" ]; then
  DATA_VERSION=$(cat "$DATA_VERSION_FILE")
  if version_older "$IMAGE_VERSION" "$DATA_VERSION"; then
    fail "this data was migrated by L4 ${DATA_VERSION}; image ${IMAGE_VERSION} is older. Use ${DATA_VERSION} or newer."
  fi
fi

echo "llll: waiting for RustFS at ${S3_ENDPOINT}"
i=0
until curl -fsS "${S3_ENDPOINT%/}/health" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then
    fail "RustFS did not answer at ${S3_ENDPOINT%/}/health"
  fi
  sleep 2
done

echo "llll: celld deploy"
celld deploy "$CONFIG" \
  --bucket "$CELLD_BUCKET" \
  --endpoint "$S3_ENDPOINT" \
  --region "$AWS_REGION"

mkdir -p "$CELLD_WATCH"
rm -f "${CELLD_WATCH}/.migrations-applied"
if [ -f "$CELLD_WATCH/.node-started" ]; then
  echo "llll: waiting ${CELLD_RESTART_DELAY}s so a fenced node lease can expire"
  sleep "$CELLD_RESTART_DELAY"
fi
touch "$CELLD_WATCH/.node-started"

echo "llll: starting celld on ${CELLD_LISTEN}"
celld \
  --bucket "$CELLD_BUCKET" \
  --endpoint "$S3_ENDPOINT" \
  --region "$AWS_REGION" \
  --listen "$CELLD_LISTEN" \
  --internal-listen "$CELLD_INTERNAL_LISTEN" \
  --advertise "$CELLD_ADVERTISE" &
celld_pid=$!

echo "llll: celld d1 migrations apply ${DATABASE_NAME}"
i=0
# The node takes a moment to register its lease; that wait is expected, so say so instead
# of printing celld's error. Any other failure is shown as it happens.
until output=$(celld d1 migrations apply "$DATABASE_NAME" "$CONFIG" \
  --bucket "$CELLD_BUCKET" \
  --endpoint "$S3_ENDPOINT" \
  --region "$AWS_REGION" 2>&1)
do
  case "$output" in
    *"no node leases"*|*"no node in the fleet is reachable"*) [ "$i" -eq 0 ] && echo "llll: waiting for the celld node to join before applying migrations" ;;
    *) printf '%s\n' "$output" >&2 ;;
  esac
  i=$((i + 1))
  if ! kill -0 "$celld_pid" 2>/dev/null; then
    fail "celld exited before migrations applied"
  fi
  if [ "$i" -ge 60 ]; then
    fail "celld d1 migrations apply ${DATABASE_NAME} did not succeed"
  fi
  sleep 3
done
printf '%s\n' "$output"
touch "${CELLD_WATCH}/.migrations-applied"
if [ -n "$IMAGE_VERSION" ]; then printf '%s\n' "$IMAGE_VERSION" > "$DATA_VERSION_FILE"; fi
echo "llll: celld d1 migrations apply ${DATABASE_NAME} finished"
if [ -n "${ADMIN_PASSWORD:-}" ]; then
  echo "llll: serving ${PUBLIC_ORIGIN}; sign in as ${ADMIN_EMAIL} with ADMIN_PASSWORD"
else
  echo "llll: serving ${PUBLIC_ORIGIN}; before an Owner exists, open ${PUBLIC_ORIGIN}/setup and enter SETUP_TOKEN"
fi

if [ "${LLLL_DEV_RELOAD:-false}" = true ]; then
  export CELLD_CONFIG="$CONFIG" DATABASE_NAME CELLD_BUCKET CELLD_INTERNAL_LISTEN
  sh /usr/local/bin/llll-dev-reload &
  reload_pid=$!
fi

set +e
wait "$celld_pid"
status=$?
set -e
if kill -0 "$celld_pid" 2>/dev/null; then
  wait "$celld_pid"
  status=$?
fi
exit "$status"
