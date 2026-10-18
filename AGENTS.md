# L4 (llll.gg)

MIT licensed independent community software. Nuxt 4, Pinia, TanStack Query, Workers/celld, D1, R2, Durable Objects.

## Five parts

| Part | Source / entry point | Responsibility |
| --- | --- | --- |
| Instance | `apps/instance` | Local Accounts, login, sessions, Server directory and provisioning. |
| Server | Root Nuxt runtime (`app`, `server`) | One community's Members, Roles, conversations, content, files and realtime. |
| Shell | `apps/site`, `/open` and Server UUID routes | Bookmarks and navigation; embeds each Instance's own Client. |
| Landing | `apps/site`, `/` | Public product entry point. |
| Docs | `docs`, `apps/site` at `/docs` | Source documentation and its web index; production links are pinned to the release tag. |

Landing, Shell, the Docs index and `/deploy` (Instance installer) share the official Worker `llll`. Instance and Server are separately deployable release artifacts. `apps/client` is a compatibility redirect to the Shell. iOS/macOS packaging is frozen.

## Domains

- Production: `https://llll.gg`.
- Native PR Previews: `https://<preview-slug>.dev.llll.gg`. The base `dev.llll.gg` does not serve production or a shared development app.
- Production and Preview `workers.dev` URLs remain disabled. Domain administration uses the connected Cloudflare API.
- Customer Instances and Servers use operator-owned origins; they do not depend on an official hosted Instance or demo Server.

## Working rules

- One Instance owns accounts, sessions and a directory of servers. Each server owns its Worker, D1 database, private files bucket and Durable Objects.
- The official web/PWA/Telegram Shell embeds each Instance's own Client through a small postMessage protocol.
- Server authorization, removals and roles stay local even when an installation introduces an identity. Never grant access by email matching.
- Accounts and login stay local to the installation. Public server IDs are UUIDv4; shell bookmarks and routing metadata do not grant membership.
- DM stays inside a server. Gitrew and cross-product integrations are later work.
- Keep backup destinations separate from live file buckets. Never delete backup buckets with servers.
- Fresh histories start at separate `0000` baselines for server and installation. Merged migration SQL is immutable. This fresh history starts at 0.1.0-alpha.1; it has no upgrade path from the archived prototype.
- Keep personal targets and credentials in ignored files. Verify the target checkout and Git remote before mutations.
- Preserve unrelated work. Changes after the initial bootstrap go through focused PRs to main with local and isolated deployment verification. Published release tags/assets are immutable.
- Never deploy application code from this machine, including through Wrangler or a direct API upload. Application deployments run only in Cloudflare Workers Builds from Git: PR -> Worker Preview -> protected main. Ordinary merges never change production. Only a merged PR labelled release that increases the shared package version may publish all components and trigger production from immutable release artifacts. There is one main and no production branch. The connected Cloudflare API tool is for administrative configuration and cleanup. Local Wrangler is limited to types, dry runs and isolated development.

## Guides

- [Product language](CONTEXT.md): canonical terms and compatibility spellings.
- [Releases](docs/releases.md): shared version, release PR, publication, production promotion and retries.
- [Deployment](docs/deployment.md): official web, customer Instance/Server boundaries, domains and credentials.
- [Preview verification](docs/worker-previews.md): required checks, isolated fixtures and Preview data cleanup.
