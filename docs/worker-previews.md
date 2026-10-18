# Isolated verification

Feature/fix PRs target `main`. Before merging, run lint, type checks, unit tests, migration validation, the Instance integration fixture and an isolated deployment. The initial migration baselines are immutable after merging; append the next numbered migration from current main and update its runtime registry.

Cloudflare Workers Builds is connected to `inchidev/llll`. Each open same-repository PR to main gets a native `llll` Worker Preview named after its branch, with a separate `llll-portal-pr-N` D1. The runner verifies the exact PR head and deployed `/api/health` commit. Production OAuth and portal secrets are excluded from Previews. The deployed Preview check and CI must pass before merging. Main builds deploy production; release publication remains a separate explicit action.

GitHub Actions also builds immutable preview artifacts and tests fresh Instance/Server boundaries. Those artifacts are not uploaded from developer machines. Use the local fixture below to verify community flows independently of the official web Preview. Cloudflare administration and cleanup use only the connected API. Never delete preserved backup buckets. Per-PR D1 data is retained until administrative cleanup; it is never reused by another PR or production.

For a local three-Worker fixture:

```sh
pnpm build
pnpm exec wrangler deploy --dry-run --config wrangler.installer.jsonc --outdir .installer/bundle
pnpm build:instance
node scripts/test-instance.mjs --serve
```

The fixture tests fresh owner bootstrap, installation sessions, two D1/R2 boundaries, invitation permissions, account logout and a one-use PKCE client handoff. Its generated credentials live only in ignored `.deployment` files. Stop it after browser verification.

It dispatches requests in process. It therefore cannot decide anything about a WebSocket handshake, a redirect, static asset lookup or any other transport-level behaviour — treat those as unverified until they are exercised against the target runtime. See [self-host findings](self-host-findings.md).

To browse that fixture through the shell the way an installation sees llll.gg, start it with the shell origin allowed and run the site beside it:

```sh
LLLL_TEST_EMBED_ORIGIN=http://localhost:3100 node scripts/test-instance.mjs --serve
pnpm exec nuxt dev apps/site --port 3100
```

Then open `http://localhost:3100/open?instance=http://localhost:18984`. The embed origin is also a client origin, so `/.well-known/llll` passes the shell's cross-origin check. Both servers stay reached through the installation at `/s/<id>/`; ports `18985` and `18986` are service bindings, not browsable addresses.
