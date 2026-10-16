# Remote development

Use one command, `pnpm dev:remote`, to run the local Nuxt frontend against a
standalone L4 server using local authentication. Personal hostnames and
deployment resource identifiers belong in ignored local configuration, never
in package scripts, tests, or committed examples.

## Select the backend

Set the target in `.env`:

```dotenv
LLLL_DEV_PROXY_ORIGIN=https://chat.example.com
```

```bash
pnpm dev:remote
```

Or select an isolated local profile containing that variable:

```bash
pnpm dev:remote -- --env-file .env.personal
```

Or pass a URL directly:

```bash
pnpm dev:remote -- https://chat.example.com
```

An explicit URL overrides the environment. Shell environment variables override
the selected file. Without `--env-file`, the command reads `.env` if present.
With `--env-file`, both the launcher and Nuxt load that file instead of `.env`.
A missing explicit file fails before starting Nuxt. All `.env.*` profiles except
`.env.example` are ignored by Git.

## What runs where

Open `http://localhost:3000`. The current frontend source runs locally with Nuxt
hot reload. Requests to `/api` are proxied to the selected backend, with cookie
and Origin rewriting. WebSockets connect directly to the remote backend using
short-lived socket tickets.

The deployed backend runs its own API, Durable Objects, Workers AI, Browser Run,
and storage. Local server changes do not run in this mode. No
Cloudflare credentials or copy of the backend's `AUTH_SECRET` are needed for the
frontend connection. Sign in separately on localhost; browser sessions are
origin-scoped. Writes affect the selected installation.

Cloudflare Access servers are not supported by this proxy mode. The
Access session cookie belongs to the deployed hostname and is not sent with
localhost API requests. Use an isolated password-login server for
remote frontend development until an explicit Access development bridge exists.

## Backend development

Use a personal Cloudflare server with its own Worker, D1, R2, KV, Durable
Objects, Workers AI, and Browser Run. Deploy the current feature branch to
that server when testing backend changes, then exercise it through the
local frontend. Keep its deployment config and credentials outside Git.

The shared integration server should follow `main`; personal servers
can run feature branches before their PRs are merged. Use separate resources so
schema changes and experiments do not affect the shared installation.

`pnpm dev:remote` only starts the frontend; it never deploys or applies migrations.
For local backend execution, use `pnpm dev` or `pnpm dev:full` instead.

A temporary `wrangler dev --remote` session is not a complete substitute for a
L4 installation because local and remote binding behavior differs. See
[Cloudflare's development binding support](https://developers.cloudflare.com/workers/local-development/bindings-per-env/).

For installation identity, routing and multiple servers, use the three-Worker fixture in [worker-previews.md](worker-previews.md). The root-only proxy does not simulate an installation controller.
