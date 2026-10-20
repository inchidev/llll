# Local standalone development

Use Node 24, pnpm 10 and a running local Docker Engine (Docker Desktop,
OrbStack or Colima). Install the checkout's dependencies once:

```sh
pnpm install --frozen-lockfile
pnpm dev:stack
```

This starts a standalone Server on celld with RustFS, its Client with Vite
hot reload, a Caddy gateway, and a local Shell with hot reload. The launcher
prints the selected addresses and the location of a private owner setup link.
Open that link, choose the owner's name and password, then connect through
the local Shell. No Cloudflare account, deployed Server or external service
is needed. The initial local owner email is `owner@example.com`; change
`ADMIN_EMAIL` in the private configuration before claiming if desired.

The default Client address is `http://localhost:3000`; the Shell is normally
`http://localhost:3002`. Busy ports are skipped on the first run. To select
ports explicitly on the first run:

```sh
pnpm dev:stack -- --port 3100 --frontend-port 3101 --shell-port 3102
pnpm dev:stack -- --docker-context colima
```

`--no-shell` runs just the standalone Server and Client. The launcher accepts
only local Unix-socket Docker contexts and refuses remote Docker hosts.
It does not install Docker, change the active Docker context, or deploy to
Cloudflare. Start Colima yourself with `colima start` when using it.

## Source and state

Each checkout/worktree gets a distinct Compose project name derived from its
absolute path. This scopes its network, RustFS volume, celld volume, Caddy
volumes and development image. Separate worktrees can run at the same time.
Moving a checkout changes that default project name; retain the generated
configuration to keep its existing storage.

Ignored `.deployment/dev-stack/.env` holds the generated secrets, owner email,
ports and project name. Re-running the launcher reuses them. Do not delete it
to fix a build error: `AUTH_SECRET` encrypts stored credentials as well as
signing sessions. The private `setup.url` is generated after health and
discovery succeed, and stops containing a claim after the Server is ready.
These files are mode 0600 and do not belong in Git or shared logs.

The Server keeps its own Accounts, sessions, membership, persistent UUID,
messages and files. The local Shell has a separate directory database and
grants no membership. Its loopback-only development API permits localhost
origins; this does not enable local origins in production.

## What reloads

- Client changes use Vite HMR. Caddy sends API requests, discovery and
  WebSockets to celld, and Client/HMR traffic to Vite, under one Server origin.
- Backend changes use Nitro's Rollup watcher with the existing production
  Worker entry and runtime shims. Successful builds publish a completion
  marker with an immutable local build snapshot. The development container applies pending migrations, deploys the
  completed Worker to its private fleet bucket, then calls celld's private
  reload endpoint. Failed compilations keep the previous deployment serving.
- Shell pages use Vite HMR; its API Worker is rebuilt separately and retains
  its own local database.
- Restart the command after changing environment variables, Nuxt configuration,
  the migration directory or Compose/Docker files. Schema changes are forward
  migrations; source hot reload is not a database rollback.

The first backend compile is heavier than subsequent edits. Neither a Client
edit nor an API edit rebuilds the runtime Docker image. No frontend bundle is
built for backend development. Backend development source maps are disabled to
keep Rollup's retained graph small; Client HMR and production source-map
settings are unchanged. Node, pnpm and Vite run on the host; the Linux
celld runtime image is built natively for the Docker host's architecture.
Vite's internal Client port binds to the host's interfaces so the Caddy
container can reach it; the public gateway and Shell bind to loopback. Use
this development mode only on a trusted development machine/network.

## Stop, inspect, and run a complete build

```sh
pnpm stack -- status
pnpm stack -- logs
# Ctrl+C in dev:stack stops the host watchers and this project's containers.
pnpm stack -- stop
pnpm stack -- down
```

`stop` and `down` retain all volumes, secrets and Server identity. They never
prune Docker resources. Stop the foreground dev command before changing modes.

To exercise the complete built Client and Server through the same shared
Compose and Caddy (without HMR):

```sh
pnpm stack -- up --build
# Or load a checksum-verified published release image first:
pnpm stack -- up --image llll:VERSION
```

The source build needs substantially more memory than the development runtime.
Published L4 runtime archives are currently amd64 only; an ARM64 development
run does not establish that a published ARM64 release exists. The VPS
installer and multi-architecture release publication are follow-up work.

With `pnpm dev:stack` running, `pnpm test:stack` creates a separate disposable
Compose project and verifies owner setup, invitations, message/file access,
real WebSockets, backend reload/error recovery and restart persistence. It
removes only its random test project's volumes; it never claims or clears
the developer's Server. Run this serially: it briefly adds a temporary local
API route to exercise the backend watcher, then removes it.

Mail gateways, model APIs, Browser Run and calls remain optional Server-local
integrations. Add their existing environment variables to the private local
configuration and restart when testing them. Nothing provisions an external
provider or copies production credentials automatically. Live file storage is
not a backup destination; configure backups separately before keeping real data.
