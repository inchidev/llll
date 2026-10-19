# L4 (llll.gg)

MIT licensed independent community software. Nuxt 4, Pinia, TanStack Query, Workers/celld, D1, R2, Durable Objects.

## Four parts

| Part | Source / entry point | Responsibility |
| --- | --- | --- |
| Server | Root Nuxt runtime (`app`, `server`) | One community's Accounts, login, sessions, Members, Roles, content, files and realtime. |
| Shell | `apps/site`, `/create` and Server UUID routes | Device-local bookmarks and navigation; embeds each Server's own Client. |
| Landing | `apps/site`, `/` | Public product entry point. |
| Docs | `docs`, `apps/site` at `/docs` | Source documentation and its web index, pinned to the released version. |

Landing, Shell, Docs and `/create` (Connect / Cloudflare / VPS) share the official Worker `llll`. Each standalone Server is separately deployed. `apps/client` redirects to the Shell. Native iOS/macOS packaging remains frozen.

## Domains

- Production: `https://llll.gg`.
- Native PR Previews: `https://<preview-slug>.dev.llll.gg`. The base `dev.llll.gg` does not serve production or a shared development app.
- Production and Preview `workers.dev` URLs remain disabled. Domain administration uses the connected Cloudflare API.
- Customer Servers use operator-owned origins; they do not depend on an official hosted service or demo Server.

## Working rules

- Each standalone Server owns its Accounts, login, sessions, Worker, D1 database, private files bucket and Durable Objects.
- The official web/PWA/Telegram Shell embeds each Server's own Client through a small postMessage protocol.
- Server authorization, removals and roles stay local. Any future external identity provider must link explicitly; never grant access by email matching.
- Accounts and login stay local to each Server. Its persistent UUIDv4 is its only Server ID. Shell bookmarks and directory metadata grant no membership.
- DM stays inside a server. Gitrew and cross-product integrations are later work.
- Keep backup destinations separate from live file buckets. Never delete backup buckets with servers.
- The active Server schema starts at `drizzle/server-migrations/0000_server_baseline.sql` with schema marker `server-v1`. It accepts fresh databases only. Append migrations within this lineage; merged SQL and published tags/assets are immutable. Earlier schema histories remain in Git and existing releases only.
- Keep personal targets and credentials in ignored files. Verify the target checkout and Git remote before mutations.
- Preserve unrelated work. Changes after the initial bootstrap go through focused PRs to main with local and isolated deployment verification. Published release tags/assets are immutable.
- Never deploy application code from this machine, including through Wrangler or a direct API upload. Application deployments run only in Cloudflare Workers Builds from Git: PR -> Worker Preview -> protected main. Ordinary merges never change production. Only a merged PR labelled release that increases the shared package version may publish all components and trigger production from immutable release artifacts. There is one main and no production branch. The connected Cloudflare API tool is for administrative configuration and cleanup. Local Wrangler is limited to types, dry runs and isolated development.

## Guides

- [Product language](CONTEXT.md): canonical terms.
- [Releases](docs/releases.md): shared version, release PR, publication, production promotion and retries.
- [Deployment](docs/deployment.md): official web, customer Server boundaries, domains and credentials.
- [Preview verification](docs/worker-previews.md): required checks, isolated fixtures and Preview data cleanup.
