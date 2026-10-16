# L4 · llll.gg

Independent communities, together in one client. MIT licensed chat, threads, rich messages, tasks, mail, apps, structured data, documents and optional calls.

One installation can contain many servers. Every server gets its own Worker, D1 database, private files bucket and Durable Objects. The web/PWA/Telegram shell groups servers by installation and embeds each installation’s own client. Accounts and login stay local; direct addresses remain fully usable. No public managed-hosting marketplace is required.

## Deploy

Start with [the installation model and account/credential flow](docs/installation.md). Deploy an installation once, create its owner, then provision or register isolated servers inside it. The `/deploy` installer uses Cloudflare OAuth and transfers provisioning credentials to the new installation. Its operator must configure a public OAuth client and a verified release. API-token source deployment remains available.

Run on your Cloudflare account or your VPS with celld and Docker Compose. Start with [deployment instructions](docs/deployment.md). On VPS:

```sh
node scripts/self-host-installation.mjs .deployment/my-installation https://chat.example.com main games
docker compose -f .deployment/my-installation/compose.json up -d --build
```

The generated files contain private credentials. Keep them out of Git. Configure optional Telegram, calls, AI and email providers when needed. Backup destinations are separate from live file buckets.

## Develop

Node 24, pnpm 10. `pnpm install --frozen-lockfile`, then `pnpm dev`. Use `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm db:migrations:check`. [Worker verification](docs/worker-previews.md) includes a three-Worker integration fixture.

The root is one server runtime. `apps/installation` owns installation accounts/directory/gateway, `apps/site` provides the independently deployed landing, iframe shell and installer. `apps/client` redirects the previous client entry to the shell. iOS/macOS packaging is frozen while web, PWA and Telegram are developed.

Read [product language](CONTEXT.md), [runtime architecture](docs/architecture.md), and [operations](docs/deployment.md). Gitrew headless integration, OpenRivers/AfterPrompt embedding and cross-server DMs are deferred.

Source attribution is preserved in [NOTICE.md](NOTICE.md) and [LICENSE](LICENSE).
