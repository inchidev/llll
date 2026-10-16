# Installations, servers and embedding

An installation is an independent L4 deployment at one origin. It owns its accounts, login, sessions, invitations and server directory. Each server owns a separate Worker/celld process, database, live files bucket and Durable Objects. Backup destinations remain separate. There is no separate Admin app or required shared L4 account.

## Web, PWA and Telegram

The official site provides a landing page, `/deploy`, and a small shell. `/open` connects an installation by address. `/<public-server-uuid>/...` resolves an installation and opens its own client in an iframe. The installation also works at its direct address. iOS and macOS packaging are frozen.

The shell does not render chat or call server content APIs. The installation sends bounded server metadata, unread state, navigation and call lifecycle events. The shell sends navigation, theme and, when enabled by the installation, Telegram launch proof. Messages are validated and pinned to the exact origin and iframe window. Passwords, Cloudflare credentials, session tokens and chat content are never part of the shell bridge.

An installation's `EMBED_ORIGINS` sets the additional permitted embedders; `https://llll.gg` is allowed by default. CSP `frame-ancestors` restricts embedding. An iframe hides the installation's outer rail. AfterPrompt/OpenRivers can use the same mode after their origins are allowed by the installation operator.

Iframe login can use the installation's own form. An optional sign-in window authenticates directly with the installation and returns a one-use S256-bound code to the opening iframe. The iframe exchanges it with the installation; the parent shell receives no session credential. A standalone session is not assumed to share cookies with an embedded session.

## Public IDs

Every server has a cryptographic UUIDv4 public ID. New provisioned servers also use UUIDs internally. Migration `0001_server_public_ids.sql` assigns UUIDs to existing servers without changing their local IDs or pairing keys. The official directory stores only UUID-to-origin mappings, verifies each mapping against the installation's well-known endpoint and refuses ownership replacement. It is not an account or content database.

The shell stores its bookmarks on the current device. There is no cross-device account sync. A direct installation does not depend on the directory being available.

## Cloudflare deployment

`/deploy` uses a public Cloudflare OAuth client with S256 PKCE. The browser-bound temporary grant is encrypted in the portal's D1, expires after one hour and is removed after successful handoff. Resumable deployment phases create the installation's control D1, a separate backup bucket, assets and controller Worker. Names, encryption secrets and setup claims remain stable across retries. The user picks a published GitHub release version; the portal verifies that release's own `SHA256SUMS` plus per-module hashes before deploying it. Published tags and assets are immutable; a repair needs a new version.

The installation receives its encrypted OAuth grant in its own control D1 and refreshes it using a serialized refresh lease. Its owner then creates servers from installation settings. A scoped API token remains an alternative. Source bootstrap instructions remain in deployment.md.

The portal operator configures `AUTH_SECRET`, `PUBLIC_ORIGIN` and `CLOUDFLARE_OAUTH_CLIENT_ID`, applies `apps/site/migrations`, then deploys `apps/site`. No release version is pinned in portal configuration. Register the exact `<PUBLIC_ORIGIN>/api/deploy/callback` redirect with Cloudflare; use a public OAuth client with token authentication method `none`. Required scopes are defined in `shared/cloudflare-oauth.ts`. Public OAuth client registration and a real consent/deployment check are required before enabling the live installer.

## VPS

The private Compose generator deploys the installation and separate celld services. Create the owner using its claim link and register the generated servers. The client cannot control Docker or SSH. Updates and domains are operated through the private Compose/TLS configuration. Automatic SSH deployment is deferred.

## Telegram

An installation may use its own bot token, or explicitly trust a Mini App bot ID using `TELEGRAM_TRUSTED_BOT_ID`. Third-party proof uses Telegram's Ed25519 public key, validates the bot ID and a five-minute timestamp, and creates a local installation session. It does not require the bot token or a shared L4 identity service. Account linking remains explicit; invitations and local server permissions still apply. Direct browser Telegram login additionally needs that installation's OIDC configuration.

## Credentials and recovery

Cloudflare provisioning credentials belong to the installation. Optional call/mail/AI credentials belong to the server. A separate pairing key introduces identities to each server, and local roles/removals remain authoritative. The infrastructure operator controls the deployment and is a trust authority.

Back up control D1, every server's data/files and the original encryption secrets. Content exports do not include active sockets, running agents or third-party call state. Published migration SQL remains immutable even when Git history is reset.
