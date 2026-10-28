# Standalone Server stabilization

Accepted architecture: standalone Server + optional Shell, Landing and Docs. Each Server owns Accounts, login, UUIDv4 identity, D1, files, DOs and local permissions. iOS/macOS packaging, cross-server DM/federation, global L4 identity and commercial hosting remain deferred.

Acceptance requires two independent Servers and two people: create → claim owner → invite → accept → exchange messages/files → reload → reconnect. Repeat direct and in Shell. Verify denial, removal, logout/session revocation, one unavailable Server, and matching UUID after backup/restore. Test Cloudflare and celld separately; local fixtures do not prove physical devices, optional providers or cross-site browser policies.

The active Server schema is `server-v2`, beginning at `drizzle/server-migrations/0000_server_baseline.sql`. Create a fresh database; earlier schemas cannot be upgraded into this line. Published artifacts and Git history remain unchanged.
