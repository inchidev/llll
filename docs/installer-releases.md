# Deployment artifacts

One immutable L4 release contains matching installation/server modules, client assets and migration chains. The site and common client deploy independently from the same repository. The public site does not hold Cloudflare credentials or manage customer installations.

| Asset | Purpose |
| --- | --- |
| `llll-deployment.json` | Complete verified bundle: `site`, `client`, `installation`, `server` modules; static assets; separate installation/server migrations. |
| `llll-cloudflare-manifest.json` | Server runtime manifest with immutable asset URLs, hashes, compatibility flags and DO classes. |
| `llll-worker.mjs` | Bundled server Worker. |
| `llll-assets.json` | Server client assets and ordered server migrations. |
| `llll-deployment-core-<version>.tgz` | Provisioning library for installation controllers and operator tooling. |
| `SHA256SUMS` | Checksums for every accompanying release file. |

Releases through 0.1.1 named the library package `llll-admin-core`; those published artifacts remain immutable. Current source uses `@llll/deployment-core`. This package is a library, not a separately deployed Admin.

Build with `pnpm release:installer`. `pnpm build:deployment` builds all four modules, static assets and migration arrays. The release workflow includes the full bundle and generates checksums before publication. Verify module SHA256, asset hashes/sizes and ordered migration names before deploying. Never modify a published tag or asset.

`packages/deployment-core` creates or updates one server Worker and its resources. `apps/installation` owns the account/session boundary and calls the library after checking installation owner authority. The operator bootstraps the installation itself with `scripts/deploy-installation.mjs` or the private celld Compose generator.

No release deploys a separate account-wide Admin or a public control-plane callback. Domain routing and resource removal remain operator-managed. A server update preserves its data bindings, auth/provider secrets and DO namespaces, and applies only pending ordered migrations. Initial migration baselines are immutable; append schema changes instead of rewriting published SQL.
