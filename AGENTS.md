# L4 (llll.gg)

Source-available software under the Elastic License 2.0: one workspace for a team and its AI agents. Nuxt 4, Pinia, TanStack Query, Workers/celld, D1, R2, Durable Objects.

## Two repositories

| Repository | Holds | Ships |
| --- | --- | --- |
| `inchidev/llll` (this one, source available) | The Server and its Client (`app`, `server`, `workers`, `shared`, `drizzle`), packages including `deployment-core`, native apps, the user docs text in `content` and `docs/release-notes` | Immutable releases only |
| `inchidev/llll-cloud` (private) | One Worker for all of llll.gg: landing, pricing, blog, billing, accounts, `/create`, Docs, Changelog, Cloud provisioning and the fleet | From its own `main` |

The Docs text lives here because it describes this code, and it reaches llll.gg/docs only through a release, pinned as `llllRelease` in `llll-cloud`. Prices and plans live only in `llll-cloud`: the Docs link to [Pricing](https://llll.gg/pricing) and never quote them. Say what works today plainly, and mark L4 Cloud and the native apps as coming.

This repository deploys nothing of ours. See [one Server per tenant](docs/adr/0008-server-per-tenant.md).

## Working rules

- A Server is one organization. It owns its Accounts, login, sessions, Worker, D1 database, private files bucket and Durable Objects. Its persistent UUIDv4 is its only Server ID.
- A Space is a department of one Server, with one sign-in and shared people. It is not a boundary between strangers: that is a Server.
- A Client is served only by its own Server and is never embedded: Server CSP is `frame-ancestors 'self'`. Going to another Server is an ordinary page load. See [Server list](docs/adr/0007-server-list.md).
- Server authorization, removals and roles stay local. Any external identity provider, including an L4 Cloud account, must link explicitly; never grant access by email matching.
- An Account is a username and password; email is optional and counts for sign-in and reset only once verified. Read the address through `accountEmail()`: an Account without one holds a placeholder that must never leave the Server.
- DM stays inside a Server.
- Keep backup destinations separate from live file buckets. Never delete backup buckets with Servers.
- The Server schema starts at `drizzle/server-migrations/0000_baseline.sql` with marker `server-v1`, for fresh databases only. Unreleased schema is rewritten in place, so one release adds at most one migration. Merged released SQL and published tags and assets are immutable.
- `drizzle/schema.ts` is the source of the tables: change it and run `pnpm db:generate`. Triggers and search go in `pnpm db:generate:custom`. `pnpm db:schema:check` fails if the two disagree.
- Keep personal targets and credentials in ignored files. Verify the target checkout and Git remote before mutations.
- Changes go through focused PRs to `main`. Only a merged PR labelled `release` that raises the shared version publishes artifacts.
- **Server installation and updates** upload only a published, checksum-verified release, never unreleased or locally built code: from `/create` through the customer's own browser-bound OAuth grant, from a Server with its Owner's consent, or from L4 Cloud to its own namespace. Customers need neither Git nor GitHub. Recommend, never require, a separate Cloudflare account per Server.
- **The workspace is free; L4 sells Managed Compute.** A Server runs work on one kind of Compute Node, on the operator's VPS, on their Cloudflare account or as a managed worker from `llll-cloud`; provisioning and billing live only there. Never add a price per Server, Space, person, message or feature. See [Compute is the business](docs/adr/0009-compute-as-the-business.md).

## Guides

- [Product language](CONTEXT.md): canonical terms.
- [Releases](docs/releases.md): shared version, release PR and publication.
- [Deployment](docs/deployment.md): Server boundaries, domains and credentials.
- [Local development](docs/local-development.md): running the Server and Client.
