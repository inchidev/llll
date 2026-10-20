# Deploy a standalone Server

Deploy one Server, claim its owner, then invite members. Accounts, files and conversations belong to this Server. It works at its direct origin and through the optional Shell.

## Cloudflare

The Shell's plus button opens `/create`, with three tabs: **Connect**, **Cloudflare** and **VPS**. Connecting by address, configuring a Cloudflare deployment and reading VPS setup all stay on that page. Tab links use `?tab=cloudflare` or `?tab=vps`. The Shell logo opens `/` on the current origin, including in Previews. Existing `/open`, `/deploy` and `/servers` links redirect to `/create` while preserving connection parameters; old `/deploy?method=vps` links select VPS.

The Cloudflare tab selects an account, Server name, admin email and published standalone release, then configures a Git-connected Workers Build. A new Server starts on the customer's `workers.dev` hostname; domain selection is not part of this installer. The PWA starts at `/create`; its existing manifest ID remains stable for already installed copies.

The account must have Cloudflare's Git integration for this repository and an eligible Workers Builds deployment token with Workers, D1, R2 and KV rights. Register `workers-ci.read` and `workers-ci.write` on the L4 OAuth client alongside the other scopes in `shared/cloudflare-oauth.ts` **before publishing the web release that requests them**. Workers script permissions alone do not replace these Builds scopes. Existing authorizations need fresh consent through **Reconnect Cloudflare**. The installer checks Builds token access before starting a deployment; missing rights or prerequisites leave the form retryable and do not allocate a Server. The installer never uploads application code itself.

The Build runs `node scripts/server-deploy.mjs`. Configure `CLOUDFLARE_ACCOUNT_ID`, an appropriate deployment token, `LLLL_SERVER_WORKER`, `LLLL_SERVER_RELEASE`, `LLLL_SERVER_NAME`, `LLLL_SERVER_OWNER_EMAIL`, `LLLL_SERVER_ORIGIN` and private `LLLL_SERVER_SETUP_TOKEN`. Optional custom domains use `LLLL_SERVER_ZONE_ID`, `LLLL_SERVER_ZONE_NAME` and `LLLL_SERVER_SUBDOMAIN`. Pin an immutable published standalone release. Ordinary main builds do not update a Server already running that version.

The deployment creates Server D1, private FILES storage, TICKETS KV, DO namespaces and a separate BACKUPS bucket. After verification, the browser opens the Server's Client in Shell automatically. Its admin email is fixed by the installer; the owner chooses a password on that Server and is signed in immediately. A private, single-use bootstrap credential travels in URL fragments between the installer, Shell and `/setup`; users do not copy or enter it. It never enters request query strings, public logs or Git. Knowledge of the admin email alone cannot claim the Server. The website retains the encrypted browser-bound OAuth grant within its one-hour installer session so the operator can list L4 Servers in an authorized account and create another Server. Only an explicit OAuth connection renews that session; polling and deployment progress do not extend it. Expired sessions require reconnection. The grant is never handed to a Server as a permanent provisioning credential.

The Cloudflare tab lists Workers carrying the current L4 Server marker. Server status comes from each Server's public discovery response; "Continue owner setup" appears only while that Server is unclaimed and this browser session holds its private claim. Device-local saved addresses remain available after expiry and are labelled separately from a refreshed Cloudflare account inventory. These bookmarks contain no claims or Cloudflare credentials and grant no Server membership. Creating another Server retains earlier setup claims only inside the same encrypted installer session. Access-token expiry, installer-session expiry and each Server's own login session are independent.

Application code may only deploy in Workers Builds from Git. Local Wrangler is limited to types, dry runs and isolated development. Connected Cloudflare API tools administer resources, domains and build configuration; they never upload application code from the developer machine.

## VPS / celld

Use `self-host/docker-compose.yml` or the Coolify standalone template with the portable image from a verified release. Configure `PUBLIC_ORIGIN`, `AUTH_SECRET`, `ADMIN_EMAIL`, private `SETUP_TOKEN` and persistent storage credentials in ignored/private operator configuration. Place TLS in front of celld, open `/setup#claim=…`, set the owner password and invite another person.

Keep each Server's D1, files and DO state separate. Preserve its original encryption secret and storage across restarts and updates. Operator Docker/SSH credentials do not enter the Client. Verify transport and browser behavior on celld separately from Cloudflare.

## Providers and recovery

RealtimeKit, AI and mail are optional Server-local settings. Cloudflare deployment does not imply they are configured. RealtimeKit's API token remains backend-only; clients receive participant credentials. See [runtime architecture](architecture.md) and [celld reference](self-host/celld.md).

Back up Server D1, live files and encryption/deployment secrets to a destination separate from live files. Backup buckets survive Server deletion. Restore into isolated resources and verify the same UUID, accounts, roles, messages and files. Save local account recovery keys privately; they are single-use and revoke sessions when redeemed.

The active Server schema is `server-v1`, beginning at `drizzle/server-migrations/0000_server_baseline.sql`. Create a fresh database; earlier schemas cannot be upgraded into this line. Published artifacts and Git history remain unchanged.

Published release discovery uses GitHub REST with an optional public-repository token, and falls back to the public release feed on quota responses. Feed entries must name a supported version and expose the deployment artifact and manifest in published checksums; the manifest must declare the matching standalone capability. Installing still verifies every artifact checksum.
