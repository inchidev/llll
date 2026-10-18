# Self-host with Docker

One command runs L4 on a single [celld](https://celld.dev) node. [RustFS](https://github.com/rustfs/rustfs) is the S3 bucket for that node. The same deployment without Docker is [Self-host on celld](../docs/self-host/celld.md).

celld 0.6.2 has no secrets store. On startup the container writes `self-host/.env` into a gitignored `wrangler.celld.local.json` and `celld deploy` stores that `vars` object in the bucket as plaintext. Keep the RustFS volume private. Do not publish port 9000.

The image build sets `NODE_OPTIONS=--max-old-space-size=6144`. Building needs a machine with about 8 GB of free RAM. A published image skips that build on the VPS.

## Quickstart

From this directory:

```bash
cp .env.example .env
openssl rand -hex 32   # use one value for AUTH_SECRET and another for SETUP_TOKEN
# edit .env: PUBLIC_ORIGIN, AUTH_SECRET, ADMIN_EMAIL, SETUP_TOKEN, RustFS keys
docker compose up -d
```

The app listens on `127.0.0.1:8080`. The container stays unhealthy until `celld d1 migrations apply` finishes, then `http://127.0.0.1:8080/api/setup/health` returns HTTP 200. On celld the app does not create tables itself. A request that applied the bundled schema would leave those tables out of `d1_migrations`, and the next apply would stop on `table already exists`.

Then open `/setup#claim=<SETUP_TOKEN>` and create the owner. `PUBLIC_ORIGIN` must be the origin you use in the browser.

`AUTH_SECRET` and `SETUP_TOKEN` must each be at least 32 characters. The tracked `wrangler.celld.json` keeps the placeholder `invalid` on purpose. The container replaces it at startup and does not commit the result.

A celld node that misses its own lease renews by fencing itself and exiting. Compose sets `restart: always`, so Docker starts the container again. The entrypoint waits 15 seconds on that restart (`CELLD_RESTART_DELAY`) so the old lease can expire before the new process binds the node. `rustfs-perms` and `bucket-init` are one-shot and use `restart: "no"`.

RustFS is not published to the host. One Docker volume holds the fleet bucket.

## Reverse proxy and TLS

Leave L4 bound to loopback and terminate TLS in front of it. Set `PUBLIC_ORIGIN` to the public origin, then recreate:

```bash
docker compose up -d
```

Caddy on the host:

```caddy
chat.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

nginx must forward WebSocket upgrades for chat:

```nginx
server {
  server_name chat.example.com;
  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-Proto https;
  }
}
```

To listen on every interface instead of loopback, set `LLLL_BIND=0.0.0.0` in `.env`. Put the proxy on a private network if you do that.

## Upgrade

From this directory, with the stack already created:

```bash
git pull
docker compose up -d --build
```

The new container deploys the image it was built from and runs `celld d1 migrations apply <database_name>` again. Migrations that are already recorded are skipped. Expect a short outage while the single node restarts.

Each release includes `llll-runtime-linux-amd64.tar.gz` and `SHA256SUMS`. Verify the checksum, then run `docker load --input llll-runtime-linux-amd64.tar.gz`. It loads `llll:<version>` locally. Set that exact image in Compose, remove the `build` block and use `pull_policy: never`. The image is `linux/amd64`; other architectures build from the Dockerfile. See [deployment](../docs/deployment.md#vps-docker-compose-and-coolify) for the prebuilt multi-server path.

Do not change `AUTH_SECRET` during an upgrade. It signs sessions, and backup credentials stored by the app are encrypted with it.

## Backup

Stop the stack, then copy both volumes and `.env`:

```bash
docker compose stop
docker run --rm -v llll_rustfs-data:/from -v "$PWD":/to alpine:3.22 \
  tar -C /from -czf /to/rustfs-data.tgz .
docker run --rm -v llll_celld-data:/from -v "$PWD":/to alpine:3.22 \
  tar -C /from -czf /to/celld-data.tgz .
docker compose start
```

`rustfs-data` is the fleet bucket: D1, Durable Object storage, KV, workspace files, and the deployment, including plaintext Worker variables. `celld-data` is the node's local work directory. `.env` holds `AUTH_SECRET` and the RustFS keys. Store all three as private data.

Restore by stopping the stack, extracting those archives back onto empty volumes with the same names, and starting again. Keep the same `.env`.

Workspace Settings → Backups can also download a TAR of D1 SQL and R2 objects. That archive does not include the celld deployment, KV, or live Durable Object state. To load its SQL into this node while the stack is up, copy `restore.sql` into the L4 container and run:

```bash
docker compose exec llll \
  celld d1 execute llll /opt/llll/wrangler.celld.local.json \
  --file /path/inside/container/restore.sql \
  --bucket s3://cells
```

The database argument is the `database_name` (`llll` unless you set `DATABASE_NAME`). Concatenate the archive's `database/*.sql` files in order before importing. See [Manual workspace backups](../docs/deployment.md#manual-workspace-backups).

## Coolify

[self-host/coolify](coolify/README.md) is a draft one-click service. It uses Coolify's `SERVICE_FQDN_*` and `SERVICE_PASSWORD_*` variables. Coolify's proxy terminates TLS. Set `ADMIN_EMAIL` before the first deploy.

## Optional integrations

Empty values in `.env` are omitted from the generated Wrangler file.

- `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` call Workers AI, Browser Run, Email Sending, and RealtimeKit over REST. The account id is 32 hex characters. The token must be at least 32 characters.
- `AI_BASE_URL`, `AI_API_KEY`, and `AI_MODEL` are the OpenAI-compatible fallback when that token is not set.
- `MAIL_GATEWAY_URL` / `MAIL_GATEWAY_TOKEN` or `SMTP_GATEWAY_URL` / `SMTP_GATEWAY_TOKEN` send outbound mail. The process does not open an SMTP port.
- `INBOUND_EMAIL_SECRET`, `POSTMARK_INBOUND_SECRET`, `MAILGUN_WEBHOOK_SIGNING_KEY`, and `SES_SNS_TOPIC_ARN` enable inbound webhooks. Secrets must be at least 32 characters.
- `BROWSER_CDP_URL` is a private Chromium DevTools URL.

Inbound routes, mailbox vars, and the feature matrix are in [Self-host on celld](../docs/self-host/celld.md).
