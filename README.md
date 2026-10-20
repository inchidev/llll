# L4 · llll.gg

MIT licensed software for independent communities. Each Server owns its accounts, login, database, files and realtime. Chat, Tasks, Mail, Data, Apps and Agents live within that Server.

Deploy one Server on your Cloudflare account or VPS. Claim the owner, invite someone and start a conversation. Open it directly or connect its address/invitation in the official web/PWA/Telegram Shell. Native iOS/macOS packaging is frozen.

- [Server and Shell model](docs/server.md)
- [Deployment and credentials](docs/deployment.md)
- [Local and isolated verification](docs/worker-previews.md)
- [Immutable releases](docs/releases.md)
- [Product scope](docs/product.md)

Server, Shell, Landing and Docs are the four product parts. `app`/`server` implement one autonomous Server; `apps/site` serves Landing, Shell, Docs and the Server installer. A Server's persistent UUIDv4 identifies it publicly and internally; bookmarked connections do not grant membership.

Run `pnpm install --frozen-lockfile` and `pnpm dev:stack` for a local standalone Server, Client HMR and Shell on celld/RustFS/Caddy. See [local development](docs/local-development.md) for state, ports and commands. `pnpm dev:full` retains the local Wrangler path. Run `pnpm test:server` after `pnpm build:deployment` for the two-Server integration fixture.

Application deployments run only in Cloudflare Workers Builds from Git. Feature PRs get isolated Previews; ordinary merges leave production unchanged. A merged release PR with a shared version increase publishes immutable artifacts and promotes the official site. Customer Server versions remain pinned under operator control. Never deploy application code from a developer machine.

The Server schema starts at `drizzle/server-migrations/0000_server_baseline.sql` (`server-v1`). Use a fresh database; this line has no upgrade path from earlier schemas. Git history and published releases remain unchanged.
