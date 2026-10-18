# Standalone Server stabilization

Accepted architecture: standalone Server + optional Shell, Landing and Docs. Each Server owns Accounts, login, UUIDv4 identity, D1, files, DOs and local permissions. Instance runtime is retired. iOS/macOS packaging, cross-server DM/federation, global L4 identity and commercial hosting remain deferred.

Acceptance requires two independent Servers and two people: create → claim owner → invite → accept → exchange messages/files → reload → reconnect. Repeat direct and in Shell. Verify denial, removal, logout/session revocation, one unavailable Server, and matching UUID after backup/restore. Test Cloudflare and celld separately; local fixtures do not prove physical devices, optional providers or cross-site browser policies.

Feature PRs require local checks and Workers Builds Preview. Release PRs increase the shared version and publish immutable artifacts before production promotion. Never deploy application code from a developer machine or rewrite merged migration SQL. There are no running Instances to migrate; fresh standalone databases append the UUID migration after the original immutable baseline.
