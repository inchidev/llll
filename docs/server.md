# Standalone Servers

Each Server is an independently operated deployment at one origin. It owns Accounts, authentication, sessions, Members, Roles, invitations, content, files and realtime. One Server uses one Worker on Cloudflare, one D1, its own live files bucket and Durable Object namespaces. Backup storage is separate. VPS deployments use a celld service and persistent object storage.

The Server has one persistent UUIDv4 allocated in D1 before owner setup. The same UUID is used by `server.id`, APIs, storage prefixes, realtime coordination and public links. Discovery and repeated setup attempts preserve it; backup/restore preserves it. There is no `main` server ID. Accounts and membership on different Servers are independent.

## Client and Server list

A Server serves its own Client, which authenticates and calls its own HTTP, file and WebSocket APIs. Use never depends on llll.gg. A Client is never embedded: Server CSP is `frame-ancestors 'self'` and the session cookie is plain `SameSite=Lax`, not Partitioned. See ADR 0008 in [docs/adr](adr/).

A Server list is the other Servers one browser keeps in `localStorage` on one Server's origin, on one device. That Server's own page can read it; no other Server can. An entry holds an origin, a UUID and a public name. It holds no credential and grants no membership: you sign in to each Server separately. **Add a Server** in the Server menu reads the address's discovery response without credentials and refuses an address that response does not list as the Server's origin or an alias. Names refresh from discovery when the page loads. A Server that does not answer keeps its last name, and an answer with a different UUID changes nothing.

Once a list has an entry, the Client shows a rail of Servers at the far left; on a phone it appears with the navigation drawer or when signed out. Entries show a name or initial only. There are no unread counts for other Servers: notifications cover that. Going to a listed Server is an ordinary page load of another site.

The first visit to a listed Server carries `#from=<origin>` in the URL fragment, so that Server learns where you came from and offers **Add the way back?**, showing the address to check first. Nothing is added without asking, because anyone can write such a link. Lists are not synced: each holds only what was added there or accepted there.

The iOS, Android and macOS apps keep the device's list themselves. The Client's Server menu shows **All Servers**, which opens the app's own list, and there is no rail. A Server's page cannot read that list.

`/.well-known/llll` advertises `kind: server`, UUID, origin, aliases, name, version and whether registration is open. It allows any origin and takes no credentials, because another Server's Client and the installer read it.

The public name comes from the Server's current settings in D1; the installer-provisioned initial name (stored in D1) is only the fallback before owner setup. Discovery also exposes `iconUrl` (or `null`) and `updatedAt`. The versioned icon URL points to `/.well-known/llll/icon`, which anonymously serves only this Server's current PNG/JPEG/WebP/GIF branding image, with revalidation. It never accepts a bucket key or exposes other private files. The login health response uses the same appearance for the sign-in page. Names and icons are public branding; Accounts, Members and conversations remain private.

## Accounts and optional providers

Local password login, explicit social linking and local session revocation stay on the Server. Recovery keys are shown once; redemption replaces the password, consumes the key and revokes local sessions. Matching email never links accounts or grants access. Invitations and local Roles remain authoritative.

RealtimeKit, mail and AI credentials belong to the Server. Deploying it does not silently configure these providers. Its ordinary runtime does not need broad credentials for creating other Workers.

## Creation and recovery

The first journey is deploy Server → claim owner → invite member → chat. Customer Cloudflare Servers install and update from published, immutable, checksum-verified release artifacts through the customer's own OAuth grant; they need no Git integration or Workers Builds. The optional legacy Build hook only starts an existing Server's Build. VPS deployment uses the published portable image and operator-owned configuration. Optional Factory on that VPS needs systemd as process 1, or `llll factory enable --trust-shared-kernel --no-systemd` plus the manual node command documented with Software Factory. Our own official deployments use Workers Builds from Git. See [deployment](deployment.md).

The active Server schema is `server-v1`, beginning at `drizzle/server-migrations/0000_baseline.sql`. Create a fresh database; migrations append to this baseline.
