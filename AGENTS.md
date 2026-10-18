# L4 (llll.gg)

MIT licensed independent community software. Nuxt 4, Pinia, TanStack Query, Workers/celld, D1, R2, Durable Objects.

- One Instance owns accounts, sessions and a directory of servers. Each server owns its Worker, D1 database, private files bucket and Durable Objects.
- The root Nuxt runtime is one server; `apps/instance` owns Instance identity and routing; the official web/PWA/Telegram shell embeds each installation’s own client through a small postMessage protocol. iOS/macOS packaging is frozen.
- Server authorization, removals and roles stay local even when an installation introduces an identity. Never grant access by email matching.
- Accounts and login stay local to the installation. Public server IDs are UUIDv4; shell bookmarks and routing metadata do not grant membership.
- DM stays inside a server. Gitrew and cross-product integrations are later work.
- Keep backup destinations separate from live file buckets. Never delete backup buckets with servers.
- Fresh histories start at separate `0000` baselines for server and installation. Merged migration SQL is immutable. This fresh history starts at 0.1.0-alpha.1; it has no upgrade path from the archived prototype.
- Keep personal targets and credentials in ignored files. Verify the target checkout and Git remote before mutations.
- Preserve unrelated work. Changes after the initial bootstrap go through focused PRs to main with local and isolated deployment verification. Published release tags/assets are immutable.
- Never deploy application code from this machine, including through Wrangler or a direct API upload. Application deployments run only in Cloudflare Workers Builds from Git: PR -> Worker Preview -> protected main -> explicit release. The connected Cloudflare API tool is for administrative configuration and cleanup. Local Wrangler is limited to types, dry runs and isolated development.
