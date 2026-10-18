# Standalone Servers and Shell

Each Server is an independently operated deployment at one origin. It owns Accounts, authentication, sessions, Members, Roles, invitations, content, files and realtime. One Server uses one Worker on Cloudflare, one D1, its own live files bucket and Durable Object namespaces. Backup storage is separate. VPS deployments use a celld service and persistent object storage.

The Server has one persistent UUIDv4 allocated in D1 before owner setup. The same UUID is used by `workspace.id`, APIs, storage prefixes, realtime coordination and public links. Discovery and repeated setup attempts preserve it; backup/restore preserves it. There is no `main` workspace ID. Accounts and membership on different Servers are independent.

## Shell

The official web/PWA/Telegram Shell connects a Server address or invitation. It embeds that Server's own Client, which authenticates and calls its own HTTP, file and WebSocket APIs. Direct use never depends on llll.gg. The Shell receives bounded metadata, unread state, navigation and call lifecycle events; it receives no password, session token, chat content or provider credential. postMessage verifies both the exact origin and iframe source.

`/.well-known/llll` advertises `kind: server`, UUID, origin, name, version and embed origins. The official directory maps UUID directly to Server origin after checking discovery; it grants no membership. A changed identity at a bookmarked origin requires explicit reconnection. Device-local bookmarks contain metadata only; cross-device synchronization is deferred.

`EMBED_ORIGINS` adds permitted parents; llll.gg is allowed by default. CSP restricts embedding. The embedded Client hides its own outer rail. Login can happen in the iframe or a same-origin popup; the popup returns a one-use S256-bound code to its opening iframe. The iframe exchanges that code with the Server. Session credentials never pass through the parent Shell. Browser cookie restrictions require independent direct and embedded acceptance.

## Accounts and optional providers

Local password login, explicit social linking and local session revocation stay on the Server. Recovery keys are shown once; redemption replaces the password, consumes the key and revokes local sessions. Matching email never links accounts or grants access. Invitations and local Roles remain authoritative.

Telegram Mini App proof can use a Server-owned bot token or an explicitly trusted shared bot ID. The Server validates proof and creates its own session. Browser Telegram login additionally requires the Server's OIDC configuration. A future shared L4 account can provide optional login and Shell bookmark sync; it is not required today.

RealtimeKit, mail and AI credentials belong to the Server. Deploying it does not silently configure these providers. Its ordinary runtime does not need broad credentials for creating other Workers.

## Creation and recovery

The first journey is deploy Server → claim owner → invite member → chat. Cloudflare application code is deployed only by Workers Builds from Git and verified immutable release artifacts. VPS deployment uses the published portable image and operator-owned configuration. See [deployment](deployment.md).

Restore the database, live files and original encryption secrets. Keep backup destinations separate and never delete them with a Server. This transition supports fresh standalone databases; Instance-bound accounts require a separate explicit migration and are not silently detached.
