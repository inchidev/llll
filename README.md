# L4 · llll.gg

Independent communities, together in one client. MIT licensed chat, threads, rich messages, tasks, mail, apps, structured data, documents and optional calls.

One installation can contain many servers. Every server gets its own Worker, D1 database, private files bucket and Durable Objects. The common web/PWA/iOS/Telegram client groups servers by installation; each installation also serves its own client and supports autonomous login. No public managed-hosting marketplace is required.

## Deploy

Start with [the installation model and account/credential flow](docs/installation.md). Deploy an installation once, create its owner, then provision or register isolated servers inside it. Cloudflare currently uses API tokens; a hosted Cloudflare OAuth installer is not implemented.

Run on your Cloudflare account or your VPS with celld and Docker Compose. Start with [deployment instructions](docs/deployment.md). On VPS:

```sh
node scripts/self-host-installation.mjs .deployment/my-installation https://chat.example.com main games
docker compose -f .deployment/my-installation/compose.json up -d --build
```

The generated files contain private credentials. Keep them out of Git. Configure optional Telegram, calls, AI and email providers when needed. Backup destinations are separate from live file buckets.

## Develop

Node 24, pnpm 10. `pnpm install --frozen-lockfile`, then `pnpm dev`. Use `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm db:migrations:check`. [Worker verification](docs/worker-previews.md) includes a three-Worker integration fixture.

The root is one server runtime. `apps/installation` owns installation accounts/directory/gateway, `apps/client` is the common static client Worker, and `apps/site` is the independently deployed landing. Existing mobile packaging uses Capacitor; App Store publication and physical-device acceptance are separate release steps.

Read [product language](CONTEXT.md), [runtime architecture](docs/architecture.md), and [operations](docs/deployment.md). Gitrew headless integration, OpenRivers/AfterPrompt embedding and cross-server DMs are deferred.

Source attribution is preserved in [NOTICE.md](NOTICE.md) and [LICENSE](LICENSE).
