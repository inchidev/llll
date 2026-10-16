# Deploy an installation

For accounts, server boundaries and where credentials live, read [installation.md](installation.md). Creating an installation and creating a server are separate steps. There is no separate Admin application.

L4 has four independently deployable artifacts: the landing site, common client, installation controller, and per-server runtime. A self-hosted installation serves the same SPA itself; using app.llll.gg is optional. Keep credentials in ignored local files or the provider's secret store.

## Cloudflare

For a source deployment, put `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and a unique `INSTALLATION_ID` in an ignored `.env`, then run `pnpm build:deployment && pnpm deploy:installation`. The installer creates the control database, a separate backup bucket, assets and Worker, and saves private state under `.deployment`. Retain that file when updating. `pnpm deploy:installation -- --dry-run` prints the plan without account operations. Configure a custom domain and its PUBLIC_ORIGIN together before inviting people. The bootstrap token is used by the local installer; configure provisioning credentials separately in the running installation when you want it to create/update servers. Cloudflare OAuth onboarding is not implemented.

The equivalent manual setup is:

1. Build with Node 24 and pnpm 10: `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm build:installation`.
2. Create an installation D1 and apply `apps/installation/migrations` in order. Deploy `apps/installation/.bundle/index.mjs` with the assets from `.output/public`, `INSTALLATION_DB`, a random `AUTH_SECRET`, a different random `SETUP_TOKEN`, `PUBLIC_ORIGIN`, `INSTALLATION_ID`, and `INSTALLATION_NAME`. Use the template at `apps/installation/wrangler.jsonc`.
3. Open `/connections#claim=<SETUP_TOKEN>` on that origin, create the owner account and retain the private recovery information outside Git. The setup claim can only create the first owner.
4. In Installation settings, configure a Cloudflare account ID and a scoped API token. The deployment helper needs Workers Scripts, D1, R2 and KV edit access in that account. Domain/mail/call capabilities need their own permissions only when enabled. Create a server; it gets a unique Worker, D1, files bucket, ticket KV and DO namespaces. The installation pairs its identity with that server using a distinct secret.
5. Add other common-client origins to `CLIENT_ORIGINS` explicitly. The default official client is allowed. The installation's own client is always allowed.

`RELEASE_MANIFEST` pins the immutable server release manifest used for provisioning. Updating a server uses `POST /api/installation/servers/:id/update` with `{ "version": "0.1.0" }`, owner authentication and configured provider credentials. Back up first. Never replace an immutable tag or edit a migration already released.

The connected Cloudflare API tool is the account-operation path for this repository's agents. Local Wrangler is used for types, development and bundle dry runs.

## VPS, Docker Compose and Coolify

Generate a private Compose installation:

```sh
node scripts/self-host-installation.mjs .deployment/my-installation https://chat.example.com main games
# Keep the generated directory private. It contains credentials.
docker compose -f .deployment/my-installation/compose.json up -d --build
```

Put a TLS reverse proxy in front of `127.0.0.1:8080`. Open the URL in `owner-claim.txt`, create the installation owner, then register each entry from `servers.json` under Installation settings. Each server is a private celld service with its own fleet bucket, D1, logical FILES bucket and DO state. Only the installation port is published. Server origins are pinned in `TRUSTED_SERVER_ORIGINS` by the generator; arbitrary HTTP origins are rejected.

The generated Compose file can be used as a Git-repository Compose resource in Coolify. Generate it privately and supply its secrets through Coolify rather than committing it to a public template. `self-host/docker-compose.yml` and `self-host/coolify/docker-compose.yaml` are the simpler standalone-server templates; the installation generator is the multi-server entry point.

To add a VPS server, generate/review its service configuration and register it after deployment. The web app does not get the Docker socket. To update, rebuild the same release using the existing private configuration and buckets. Do not generate replacement credentials over an existing installation. Preserve its fleet bucket, configuration, encryption secrets and reverse-proxy configuration before changing runtime versions.

Cloudflare-only features use explicit provider credentials over REST on celld. Core chat, tasks, documents, data and files run locally. See [celld operations](self-host/celld.md) for the runtime boundary.

## Telegram and shared identity

Telegram is optional. Set the bot token in Installation settings to enable signed Mini App login; configure BotFather's Mini App URL to the installation's `/connections`. Browser Telegram login additionally needs its OIDC client ID/secret and exact callback `/api/auth/callback/telegram`. Accounts link explicitly; verified Telegram numeric IDs converge across browser and Mini App flows.

An installation can use the optional shared L4 OIDC provider through `IDENTITY_ISSUER`, `IDENTITY_CLIENT_ID`, and `IDENTITY_CLIENT_SECRET`. The issuer is an installation running `IDENTITY_PROVIDER=true`. Its owner registers a confidential OAuth client with exact callback `<installation-origin>/api/auth/callback/llll`. Local password login remains available. The official web client connects to the installation using a one-use S256 PKCE handoff; session credentials never appear in callback URLs.

## Backups

Cloudflare provisioning binds a separate BACKUPS bucket by default; a deployment may instead configure an external S3 destination. Configure each server's separate R2/S3 backup destination in its settings. Never use the live files bucket as the backup destination. Preserve installation control D1 and its `AUTH_SECRET` as well: it contains accounts, memberships and encrypted pairing/provider secrets. Server exports do not contain installation accounts, active sockets, running agents or external RealtimeKit state. A complete disaster-recovery exercise must restore both layers before calling an installation recoverable.


Bound BACKUPS destinations support manual backups and the configured cron (weekly for servers, daily for installation metadata). A configured external S3 destination is used for manual backups; scheduled bound-bucket snapshots remain an independent deployment policy. Archives are streamed in bounded multipart chunks. Backups are private; define retention and monitor bucket growth as the operator. On celld, logical R2 buckets share the fleet's underlying storage failure domain, so keep an independent external copy for disaster recovery.

A newly generated recovery key replaces the previous key and is shown once. Redeeming it changes that installation account's local password, consumes the key and revokes its sessions. Store the owner key and deployment secrets privately, separately from the repository.
