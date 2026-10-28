# Contributing to L4

L4 is MIT licensed software for independent communities. Bug reports,
documentation and focused code changes are welcome. Be respectful, explain
your reasoning, and keep reports and reviews about the work.

## Before starting

Read [product language](CONTEXT.md), [the Server/Shell model](docs/server.md)
and [AGENTS.md](AGENTS.md). Discuss substantial features or architecture changes
in an issue first. Search existing issues/PRs and keep each PR focused.
For vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a
public issue. Never include credentials or customer data in reports.

## Set up a checkout

Fork the repository if you do not have write access. Create a branch from the
current upstream `main`; a separate worktree is useful for parallel work.
Use the Node version in `.node-version`, the pnpm version in `package.json`,
and a running local Docker Engine. Then run:

```sh
pnpm install --frozen-lockfile
pnpm dev:stack
```

[Local development](docs/local-development.md) explains addresses, owner setup,
hot reload, stopping services and isolated state. No Cloudflare account or
production credentials are required. Keep generated `.deployment/` state and
private environment files out of commits. Do not delete local volumes or
encryption secrets to resolve build failures.

## Implementation boundaries

- Each Server owns its Accounts, sessions, Members, Roles, data and files.
  Shell bookmarks and directory metadata never grant membership. External
  identities must be explicitly linked; matching email addresses grants no access.
- Enforce authorization on the Server, including HTTP, realtime, MCP and agent
  paths. Add meaningful regression coverage for changed access rules.
- Append schema migrations within `server-v2`; create one with
  `pnpm db:migration:create`. Never edit merged SQL or published tags/assets.
- Keep backups separate from live file buckets. Preserve unrelated work and
  use synthetic Accounts/data for verification.
- Native iOS/macOS packaging is frozen. Avoid expanding its scope incidentally.

## Validate your change

Run checks relevant to the change, and state any gaps in the PR. The full CI
also validates the local stack, VPS installer and self-host runtime.

```sh
pnpm lint
pnpm typecheck
pnpm typecheck:site
pnpm exec nuxt prepare apps/site
pnpm test
pnpm model:check
pnpm db:migrations:check
pnpm build:site
pnpm build:deployment
pnpm test:server
node scripts/test-web.mjs
```

For client wrapper type checks, run `pnpm --filter @llll/mobile typecheck`,
`pnpm --filter @llll/desktop typecheck` and
`pnpm --filter @llll/extension typecheck`. For dependency changes, include the
updated `pnpm-lock.yaml`, read upstream migration/security notes, run the
affected runtime checks and follow [security maintenance](docs/security-maintenance.md).
Never use a blanket audit fix or disable a failing security check to get a PR green.

## Open a pull request

Target `main`. Describe the problem, resulting behavior, related issue,
validation and remaining limitations. Include screenshots for visible UI
changes and update the relevant docs. Contributions are made under the
repository's MIT license; no separate CLA is required.

GitHub Actions validates PRs without repository secrets. External contributors
need a maintainer to approve fork workflow runs. Cloudflare
Previews require maintainer-controlled Workers Builds: a fork or Dependabot PR
does not gain deployment credentials. Maintainers must review untrusted changes
before arranging a same-repository branch/PR for the required deployed Preview.
The final mergeable PR head must pass required checks and Preview verification;
see [isolated verification](docs/worker-previews.md).

Application code is deployed only by Git-connected Workers Builds, never from
a developer machine. Ordinary merges do not update production. Do not bump
the shared package version or apply the `release` label to a normal PR;
maintainers publish through a separate [release PR](docs/releases.md).
