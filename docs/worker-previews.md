# Isolated verification

Feature/fix PRs target protected `main`. Run lint, root/Shell/client type checks, unit tests, immutable migration validation, builds, independent Server integration and self-host smoke. Verify the deployed PR head before merging. Ordinary merges never change production; a merged release PR publishes and promotes immutable artifacts.

The official `llll` Worker has a native Preview at `<preview-slug>.dev.llll.gg` with its own D1. Production and Preview workers.dev addresses stay disabled. CI also builds immutable candidate artifacts; developer machines do not upload them.

A Server Preview uses `scripts/server-preview.mjs` inside Workers Builds. It requires the exact head of an open mergeable PR, separate `llll-server-pr-N` D1/FILES/BACKUPS/TICKETS resources, private Preview secrets and an operator-owned HTTPS origin. Its source deployment is isolated from customer Servers and the official site. Connected Cloudflare tools configure the Worker, domain and Build; they never upload code.

## Local fixture

```sh
pnpm build:site
pnpm build:deployment
pnpm test:server
node scripts/test-server.mjs --serve
```

The two Servers listen at `http://localhost:18984` and `http://localhost:18985`. They have independent D1, FILES, BACKUPS, TICKETS, DOs and AUTH_SECRET. The fixture verifies local owner/member accounts, stable UUID identity before/after setup, invitations, messages, HTTP denial, actual WebSocket authentication, foreign-server ticket denial, logout revocation, S256 handoff/replay denial and backup restoration with the same UUID and clean foreign keys.

Start the Shell with `node scripts/test-web.mjs --serve`; open `http://localhost:19003/open?server=http://localhost:18984`. Generated fixture credentials stay in ignored `.deployment/integration/fixture.json`. Test direct and embedded login, invitation opening, server switching, reload, unread state, expired sessions and one unavailable Server. Inspect phone and desktop layouts. Local Miniflare proof does not certify Cloudflare custom domains, browser cookie policies on different sites, physical devices, or celld's network transport; verify those separately.

Keep backup destinations separate from live files. Closing a PR can remove its Preview, but retained D1 and backup buckets require administrative cleanup and must never be reused by another PR or production.
