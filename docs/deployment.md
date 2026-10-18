# Deploy an Instance

The initial `0.1.0-alpha.1` release is for fresh databases. Do not apply its baselines to archived prototype databases. Cloudflare is the first acceptance target; VPS/celld is experimental pending the transport/browser checks in [self-host findings](self-host-findings.md).

For accounts, server boundaries and where credentials live, read [Instances](instance.md). Creating an installation and creating a server are separate steps. There is no separate Admin application.

L4 has independently deployable site/shell/installer, installation controller and per-server runtime artifacts. The official shell embeds the installation’s own client; using llll.gg is optional. Keep credentials in ignored local files or the provider's secret store.

## Cloudflare Instances and Servers

Use the Instance installer at `/deploy` with a published release. It creates the Instance, its account database and a separate backup bucket in the operator's account. The owner then provisions or registers Servers inside the Instance. Each Server receives its own Worker, database, private files bucket and Durable Objects.

Team source deployments from developer machines are forbidden. The source deployment scripts enforce Workers Builds as their runner; local Wrangler is limited to isolated development, types and dry runs. Cloudflare resource administration uses the connected API. Published runtime artifacts are immutable and the fresh alpha has no upgrade path from archived prototype databases.

The operator owns provisioning credentials, local Accounts and backups. Shell bookmarks do not grant Server membership. Configure optional Telegram, mail, calls and inference providers on the relevant Instance or Server.

## Official web: Landing, Shell and Docs

The single official Worker is `llll`. It serves `/` (Landing), `/open` (Shell), `/docs` (Docs index) and `/deploy` (Instance installer). `apps/instance` and the root Server runtime are built as separate installation artifacts, not deployed as public demo accounts.

Cloudflare Workers Builds is connected to the `inchidev/llll` repository and protected `main`. Its root directory is `apps/site`, build command is `pnpm build`, production command is `pnpm deploy:production`, and Preview command is `pnpm deploy:preview`. These commands reject execution outside an identified Workers Build.

Every open same-repository PR to main gets a native Worker Preview, named `pr-N`. The deploy runner verifies the PR head SHA, allocates a separate `llll-portal-pr-N` D1 and applies the portal baseline. Previews use their own origin and disable production Cloudflare OAuth. Production uses a separate `llll-portal-production` database. No KV asset adapters or source uploads from developer machines participate.

Merge requires CI and the deployed Cloudflare Preview check. Main pushes deploy the web app through Workers Builds. A release is a later, explicit invocation of the existing tag workflow after main CI passes; published tags and assets remain immutable. Runtime installation consumes a pinned published release.

Build credentials remain in Cloudflare's token store. The production portal secret is a production-only encrypted build variable. A Preview does not receive that secret. Administrative provisioning, domain configuration and cleanup use the connected Cloudflare API.

## VPS, Docker Compose and Coolify

For the published `linux/amd64` image, download and verify the release archive before generating a private Compose installation:

```sh
version=0.1.0-alpha.1
cache=".deployment/releases/v${version}"
mkdir -p "$cache"
curl -fL "https://github.com/inchidev/llll/releases/download/v${version}/SHA256SUMS" -o "$cache/SHA256SUMS"
curl -fL "https://github.com/inchidev/llll/releases/download/v${version}/llll-runtime-linux-amd64.tar.gz" -o "$cache/llll-runtime-linux-amd64.tar.gz"
(cd "$cache" && sha256sum --check --ignore-missing SHA256SUMS)
docker load --input "$cache/llll-runtime-linux-amd64.tar.gz"
LLLL_IMAGE="llll:${version}" node scripts/self-host-installation.mjs .deployment/my-installation https://chat.example.com main games
docker compose -f .deployment/my-installation/compose.json up -d
```

The generated directory contains private credentials. Keep it out of Git. The prebuilt path has no application build and requires no registry account. For other architectures or source development, omit `LLLL_IMAGE` and run Compose with `up -d --build` instead.

Put a TLS reverse proxy in front of `127.0.0.1:8080`. Open the URL in `owner-claim.txt`, create the installation owner, then register each entry from `servers.json` under Instance settings. Each server is a private celld service with its own fleet bucket, D1, logical FILES bucket and DO state. Only the installation port is published. Server origins are pinned in `TRUSTED_SERVER_ORIGINS` by the generator; arbitrary HTTP origins are rejected.

The generated Compose file can be used as a Git-repository Compose resource in Coolify. Generate it privately and supply its secrets through Coolify rather than committing it to a public template. `self-host/docker-compose.yml` and `self-host/coolify/docker-compose.yaml` are the simpler standalone-server templates; the installation generator is the multi-server entry point.

To add a VPS server, generate/review its service configuration and register it after deployment. The web app does not get the Docker socket. To update, rebuild the same release using the existing private configuration and buckets. Do not generate replacement credentials over an existing installation. Preserve its fleet bucket, configuration, encryption secrets and reverse-proxy configuration before changing runtime versions.

Cloudflare-only features use explicit provider credentials over REST on celld. Core chat, tasks, documents, data and files run locally. See [celld operations](self-host/celld.md) for the runtime boundary, and [self-host findings](self-host-findings.md) for what a real walkthrough proved and where celld currently differs from Cloudflare.

## Telegram and shared identity

Telegram is optional. Set the bot token in Instance settings to enable signed Mini App login; configure BotFather's Mini App URL to the installation's `/connections`. Browser Telegram login additionally needs its OIDC client ID/secret and exact callback `/api/auth/callback/telegram`. Accounts link explicitly; verified Telegram numeric IDs converge across browser and Mini App flows.

There is no required shared L4 account. The installation handles direct and embedded login itself. A same-origin popup can return a one-use S256-bound login code to its opening iframe. A bounded POST navigation carries the session within the installation when switching servers; it never puts it in a URL or passes it to the parent shell.

Set `TELEGRAM_TRUSTED_BOT_ID` to opt into a shared Mini App bot without giving the installation its token. The installation verifies Telegram's Ed25519 signature and timestamp itself. Telegram and browser accounts still link explicitly.

## Backups

Cloudflare provisioning binds a separate BACKUPS bucket by default; a deployment may instead configure an external S3 destination. Configure each server's separate R2/S3 backup destination in its settings. Never use the live files bucket as the backup destination. Preserve installation control D1 and its `AUTH_SECRET` as well: it contains accounts, memberships and encrypted pairing/provider secrets. Server exports do not contain installation accounts, active sockets, running agents or external RealtimeKit state. A complete disaster-recovery exercise must restore both layers before calling an installation recoverable.


Bound BACKUPS destinations support manual backups and the configured cron (weekly for servers, daily for installation metadata). A configured external S3 destination is used for manual backups; scheduled bound-bucket snapshots remain an independent deployment policy. Archives are streamed in bounded multipart chunks. Backups are private; define retention and monitor bucket growth as the operator. On celld, logical R2 buckets share the fleet's underlying storage failure domain, so keep an independent external copy for disaster recovery.

A newly generated recovery key replaces the previous key and is shown once. Redeeming it changes that installation account's local password, consumes the key and revokes its sessions. Store the owner key and deployment secrets privately, separately from the repository.
