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

stop_celld() {
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
put_var AUTH_SECRET
put_var ADMIN_EMAIL
put_var SETUP_TOKEN
put_var APP_NAME
put_var CLOUDFLARE_ACCOUNT_ID
put_var CLOUDFLARE_API_TOKEN
put_var AI_BASE_URL
put_var AI_API_KEY
put_var AI_MODEL
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
DATABASE_NAME=$(jq -r '.d1_databases[0].database_name' "$CONFIG")
if [ -z "$DATABASE_NAME" ] || [ "$DATABASE_NAME" = "null" ]; then
  fail "wrangler config has no d1 database_name"
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
until celld d1 migrations apply "$DATABASE_NAME" "$CONFIG" \
  --bucket "$CELLD_BUCKET" \
  --endpoint "$S3_ENDPOINT" \
  --region "$AWS_REGION"
do
  i=$((i + 1))
  if ! kill -0 "$celld_pid" 2>/dev/null; then
    fail "celld exited before migrations applied"
  fi
  if [ "$i" -ge 60 ]; then
    fail "celld d1 migrations apply ${DATABASE_NAME} did not succeed"
  fi
  sleep 3
done
touch "${CELLD_WATCH}/.migrations-applied"
echo "llll: celld d1 migrations apply ${DATABASE_NAME} finished"

set +e
wait "$celld_pid"
status=$?
set -e
if kill -0 "$celld_pid" 2>/dev/null; then
  wait "$celld_pid"
  status=$?
fi
exit "$status"
