# Isolated verification

Feature/fix PRs target `main`. Before merging, run lint, type checks, unit tests, migration validation, the installation integration fixture and an isolated deployment. The initial migration baselines are immutable after merging; append the next numbered migration from current main and update its runtime registry.

CI builds a preview artifact without deployment credentials. An operator deploys it through the connected Cloudflare API tool to new resource names, verifies owner setup, two separate servers, login, permissions, files and realtime, and records that evidence on the PR. A production or sandbox update is a separate authorized rollout. Do not repoint an existing installation's D1 or bucket to a preview.

For a local three-Worker fixture:

```sh
pnpm build
pnpm exec wrangler deploy --dry-run --config wrangler.installer.jsonc --outdir .installer/bundle
pnpm build:installation
node scripts/test-installation.mjs --serve
```

The fixture tests fresh owner bootstrap, installation sessions, two D1/R2 boundaries, invitation permissions, account logout and a one-use PKCE client handoff. Its generated credentials live only in ignored `.deployment` files. Stop it after browser verification.
