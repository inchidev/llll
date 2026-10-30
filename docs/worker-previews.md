# Isolated verification

Feature/fix PRs target protected `main`. Run lint, root/Shell/client type checks, unit tests, immutable migration validation, builds, independent Server integration and self-host smoke. Verify the deployed PR head before merging. Ordinary merges never change production; a merged release PR publishes and promotes immutable artifacts.

The official `llll` Worker has a native Preview at `<preview-slug>.dev.llll.gg` with its own D1. Production and Preview workers.dev addresses stay disabled. CI also builds immutable candidate artifacts; developer machines do not upload them.

A Server Preview deploys the one staging Server Worker (`llll-server`) with a **native Worker Preview per PR** via `wrangler preview` (Wrangler ≥ 4.135) inside Workers Builds. The script `scripts/server-preview.mjs` requires the exact head of an open mergeable PR (or, on main, the current head of main for the main Preview) and private Preview secrets; it never creates a per-PR Worker. Developer machines do not run it. Connected Cloudflare tools configure resources and Builds; they never upload code.

The staging Server has its own Workers Builds configuration for the same Git repository. Its PR build runs `pnpm build` and `node scripts/server-preview.mjs` from the repository root with private Preview secrets. The official web Worker retains its separate build configuration. Workers Builds binds each job to its Worker identity, so a web Worker build must not deploy the staging Server. The staging main-branch job deploys only the [main Preview](#the-main-preview); it has no production deployment.

Native Preview behavior for the Server Worker:

- **Durable Objects and Containers** are isolated per Preview automatically and deleted with it. Every DO binding declared on the environment is mirrored under `previews.durable_objects.bindings`; a Preview fails with error 1101 otherwise.
- **D1** is isolated per PR as `llll-server-pr-N`. **R2 and KV** use the shared staging resources `llll-server-staging-files`, `llll-server-staging-backups` and `llll-server-staging-tickets`. All bindings are resolved under `previews`; the backups destination stays separate from live files.
- If unpublished D1 migrations change during a PR, `LLLL_PREVIEW_DATABASE` can select a fresh database under that PR's prefix. Workers Builds creates and migrates it. The old D1 and backup objects stay available for inspection; customer databases never use this override. Per-PR databases require explicit administrative cleanup after inspection.
- **Migrations** run in the Build with `wrangler d1 migrations apply DB --remote` against the Preview's bound database before `wrangler preview` uploads.
- **Vars and secrets are not inherited from production.** The Preview declares `PUBLIC_ORIGIN`, `ADMIN_EMAIL`, `AUTH_REGISTRATION_MODE`, `EMBED_ORIGINS`, `ACCOUNT_ID` and `SERVER_TIMING`; `AUTH_SECRET` and the owner claim come from private Preview secrets. The Build reads Cloudflare’s assigned custom Preview URL and declares it as `PUBLIC_ORIGIN`, so discovery and sessions use the actual address. It repairs only the placeholder left by older staging scripts.
- Server Previews use `<preview-slug>.server-preview.llll.gg`. The Git Build first deploys a 404-only staging parent with no data bindings, then creates the native Preview; Cloudflare requires a parent deployment before attaching a custom domain. Base routing at `server-preview.llll.gg` and all workers.dev URLs remain disabled. One shared Preview domain serves every PR; no per-PR custom domain is created. The script verifies discovery at the returned URL. Previews are public by default; put Cloudflare Access in front of `llll-server` if review traffic must be restricted, and allow the identity provider on the Preview addresses.
- Cron triggers, routes and queue consumers target only the production instance. Service bindings inside a Preview call the production service.
- Limits: 500 Previews per Worker (Paid) and 100 deployments per Preview; PR churn stays low-retention because DO state and bindings die with each Preview.

Update-flow verification can opt into `LLLL_PREVIEW_UPDATE_FIXTURE=1`. Only that Preview receives the fixture version override. `LLLL_PREVIEW_INSTALLED_VERSION` may identify an older version (never newer than the candidate package) to exercise a real upgrade to a published artifact without publishing a test release. After the upgrade, redeploy the same candidate from Git to inspect the persisted completion record and leave the Preview reviewable. Backup state and fixture Accounts must never point at customer Servers.

## The main Preview

Each PR Preview shows one change alone. The main Preview shows everything merged into main together, before any release: `https://main.dev.llll.gg` (Landing, Shell, `/create`) and `https://main.server-preview.llll.gg` (a Server). Check it before opening a release PR.

- **What deploys it.** The main-branch Builds of both Workers, from Git, after every merge. Each Build first confirms that its commit is still the head of main, so an older Build never replaces a newer one. A release does not deploy it and it never changes production.
- **Data.** It keeps its own D1 databases, `llll-main` and `llll-server-main`, across deployments: migrations apply in order on existing data, as on a customer Server that updates. Files, backups and tickets use the shared staging resources.
- **Secrets.** Nothing new. Its Server uses the same `LLLL_PREVIEW_AUTH_SECRET` and `LLLL_PREVIEW_SETUP_TOKEN` as PR Previews; its own database keeps its Accounts apart. Claim the Owner once with the setup token. Like PR Previews, the web side gets a fresh secret on each deployment, so signing in to `main.dev.llll.gg` itself lasts until the next merge; Shell bookmarks stay on the device.
- **Access.** It is public like other Previews. Put Cloudflare Access in front of `main.dev.llll.gg` and `main.server-preview.llll.gg` if it should be restricted.
- **Reset.** If its data is no longer useful, delete `llll-main` or `llll-server-main` through administrative cleanup; the next main Build creates an empty one. Keep backup destinations.

Workers Builds configuration for the main branch (administrative, not code):

| Worker | Root | Build command | Deploy command |
| --- | --- | --- | --- |
| `llll` | `/apps/site` | `pnpm build:production` (unchanged) | `pnpm deploy:production && pnpm deploy:main` |
| `llll-server` | `/` | `pnpm build` | `node scripts/server-preview.mjs` |

For `llll` the production step stays first and remains a no-op without a newer published release; `deploy:main` then builds the site from the main commit and deploys the main Preview. Change them only after these scripts are on main, or main Builds fail.

## Request timing

Server Previews set `SERVER_TIMING=1`. Every app response then carries a `Server-Timing` header, shown in the browser's Network → Timing panel, and Workers Logs get one `request.timing` line per request:

- `d1`: time spent waiting on D1 and the number of statements, with the region that served them. `d1-sql` is the part D1 spent executing SQL; the difference is network and queueing.
- `do`: time and number of Durable Object calls.
- `app`: the whole request inside the Worker. `cold` marks the first request an isolate served.

Waits are summed, so parallel calls overlap. Many short `d1` statements with a small `d1-sql` mean round trips dominate. A `cf-placement` response header shows whether Smart Placement moved the Worker. Production and customer Servers leave this off: the header shows how much work a request did, which can reveal which path it took.

## Local fixture

```sh
pnpm build:site
pnpm build:deployment
pnpm test:server
node scripts/test-server.mjs --serve
```

The two Servers listen at `http://localhost:18984` and `http://localhost:18985`. They have independent D1, FILES, BACKUPS, TICKETS, DOs and AUTH_SECRET. The fixture verifies local owner/member accounts, stable UUID identity before/after setup, invitations, messages, HTTP denial, actual WebSocket authentication, foreign-server ticket denial, logout revocation, S256 handoff/replay denial and backup restoration with the same UUID and clean foreign keys.

Start the Shell with `node scripts/test-web.mjs --serve`; open `http://localhost:19003/create?server=http://localhost:18984`. Generated fixture credentials stay in ignored `.deployment/integration/fixture.json`. Test direct and embedded login, invitation opening, server switching, reload, unread state, expired sessions and one unavailable Server. Inspect phone and desktop layouts. Local Miniflare proof does not certify Cloudflare custom domains, browser cookie policies on different sites, physical devices, or celld's network transport; verify those separately.

Keep backup destinations separate from live files. Closing or deleting a PR Preview removes its DO state; the Worker and shared staging resources live on. Each PR's isolated D1 remains available for inspection; remove it through administrative cleanup after the PR closes. Retain backup destinations and backup objects.
