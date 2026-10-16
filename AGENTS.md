# L4 (llll.gg)

MIT licensed independent community software. Nuxt 4, Pinia, TanStack Query, Workers/celld, D1, R2, Durable Objects.

- One installation owns accounts, sessions and a directory of servers. Each server owns its Worker, D1 database, private files bucket and Durable Objects.
- The root Nuxt runtime is one server; `apps/installation` owns installation identity and routing; the same frontend connects installations in web, PWA, iOS and Telegram.
- Server authorization, removals and roles stay local even when an installation introduces an identity. Never grant access by email matching.
- DM stays inside a server. Gitrew and cross-product integrations are later work.
- Keep backup destinations separate from live file buckets. Never delete backup buckets with servers.
- Fresh histories start at separate `0000` baselines for server and installation. Merged migration SQL is immutable.
- Keep personal targets and credentials in ignored files. Verify the target checkout and Git remote before mutations.
- Preserve unrelated work. Changes after the initial bootstrap go through focused PRs to main with local and isolated deployment verification. Published release tags/assets are immutable.
- Cloudflare account operations use the connected Cloudflare API tool. Local Wrangler is for types, dry runs and isolated development.
