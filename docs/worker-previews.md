# Isolated verification

Feature/fix PRs target protected `main`. Run lint, root/Shell/client type checks, unit tests, immutable migration validation, builds, independent Server integration and self-host smoke. Verify the deployed PR head before merging. Ordinary merges never change production; a merged release PR publishes and promotes immutable artifacts.

The official `llll` Worker has a native Preview at `<preview-slug>.dev.llll.gg` with its own D1. Production and Preview workers.dev addresses stay disabled. CI also builds immutable candidate artifacts; developer machines do not upload them.

A Server Preview deploys the one staging Server Worker (`llll-server`) with a **native Worker Preview per PR** via `wrangler preview` (Wrangler ≥ 4.135) inside Workers Builds. The script `scripts/server-preview.mjs` requires the exact head of an open mergeable PR and private Preview secrets; it never creates a per-PR Worker. Developer machines do not run it. Connected Cloudflare tools configure resources and Builds; they never upload code.

The staging Server has its own Workers Builds configuration for the same Git repository. Its PR build runs `pnpm build` and `node scripts/server-preview.mjs` from the repository root with private Preview secrets. The official web Worker retains its separate build configuration. Workers Builds binds each job to its Worker identity, so a web Worker build must not deploy the staging Server. The staging main-branch job performs no application deployment.

Native Preview behavior for the Server Worker:

- **Durable Objects and Containers** are isolated per Preview automatically and deleted with it. Every DO binding declared on the environment is mirrored under `previews.durable_objects.bindings`; a Preview fails with error 1101 otherwise.
- **D1, R2, KV** are bound under `previews` to the long-lived shared staging resources: `llll-server-staging-db`, `llll-server-staging-files`, `llll-server-staging-backups` and `llll-server-staging-tickets`. The backups destination stays separate from live files.
- A PR whose D1 migrations conflict with the shared staging schema overrides its own D1 with `LLLL_PREVIEW_DATABASE` (default `llll-server-pr-N` under this PR's number; a fresh name under that prefix works the same way). Workers Builds creates and migrates that database. The old D1 and backup objects stay available for inspection; customer databases never use this override. Per-PR databases are documented cleanup work, not orphaned state.
- **Migrations** run in the Build with `wrangler d1 migrations apply DB --remote` against the Preview's bound database before `wrangler preview` uploads.
- **Vars and secrets are not inherited from production.** The Preview declares `PUBLIC_ORIGIN`, `ADMIN_EMAIL`, `AUTH_REGISTRATION_MODE`, `EMBED_ORIGINS` and `ACCOUNT_ID`; `AUTH_SECRET` and the owner claim come from private Preview secrets. Discovery seeds the actual Preview origin into D1 on first request, so sessions trust it even though `PUBLIC_ORIGIN` is a fixed placeholder.
- Server Previews use `<preview-slug>.server-preview.llll.gg`. The Git Build first deploys a 404-only staging parent with no data bindings, then creates the native Preview; Cloudflare requires a parent deployment before attaching a custom domain. Base routing at `server-preview.llll.gg` and all workers.dev URLs remain disabled. One shared Preview domain serves every PR; no per-PR custom domain is created. The script verifies discovery at the returned URL. Previews are public by default; put Cloudflare Access in front of `llll-server` if review traffic must be restricted, and allow the identity provider on the Preview addresses.
- Cron triggers, routes and queue consumers target only the production instance. Service bindings inside a Preview call the production service.
- Limits: 500 Previews per Worker (Paid) and 100 deployments per Preview; PR churn stays low-retention because DO state and bindings die with each Preview.

Update-flow verification can opt into `LLLL_PREVIEW_UPDATE_FIXTURE=1`. Only that Preview receives the fixture version override. `LLLL_PREVIEW_INSTALLED_VERSION` may identify an older version (never newer than the candidate package) to exercise a real upgrade to a published artifact without publishing a test release. After the upgrade, redeploy the same candidate from Git to inspect the persisted completion record and leave the Preview reviewable. Backup state and fixture Accounts must never point at customer Servers.

## Local fixture

```sh
pnpm build:site
pnpm build:deployment
pnpm test:server
node scripts/test-server.mjs --serve
```

The two Servers listen at `http://localhost:18984` and `http://localhost:18985`. They have independent D1, FILES, BACKUPS, TICKETS, DOs and AUTH_SECRET. The fixture verifies local owner/member accounts, stable UUID identity before/after setup, invitations, messages, HTTP denial, actual WebSocket authentication, foreign-server ticket denial, logout revocation, S256 handoff/replay denial and backup restoration with the same UUID and clean foreign keys.

Start the Shell with `node scripts/test-web.mjs --serve`; open `http://localhost:19003/create?server=http://localhost:18984`. Generated fixture credentials stay in ignored `.deployment/integration/fixture.json`. Test direct and embedded login, invitation opening, server switching, reload, unread state, expired sessions and one unavailable Server. Inspect phone and desktop layouts. Local Miniflare proof does not certify Cloudflare custom domains, browser cookie policies on different sites, physical devices, or celld's network transport; verify those separately.

Keep backup destinations separate from live files. Closing or deleting a PR Preview leaves no orphaned Worker, D1 or bucket: the Worker is shared, DO state is deleted with the Preview and the shared staging resources live on. A PR that bound its own D1 override retains that database; remove it through administrative cleanup after the PR closes.
