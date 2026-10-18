---
name: llll-create-server
description: Create or verify a standalone L4 Server on Cloudflare or celld for an explicit install/create/update request.
---

# Create an L4 Server

Read `docs/server.md` and `docs/deployment.md`. Each Server owns accounts, sessions, UUID identity, content and its independent resources. There is no Instance or master node.

1. Verify the target checkout, Git remote, provider/account and existing state. Keep credentials, setup claims and targets in ignored private files; never print them.
2. Cloudflare application code deploys only in Workers Builds from Git. Use the connected API for administrative configuration and cleanup, never application uploads. Feature PRs require isolated Preview proof; publish production only from a merged release PR and immutable verified assets. Local Wrangler is for types, dry runs and isolated development.
3. Create the Server through its Git-connected Build or the supported installer. Pin a published standalone release and preserve resource names and secrets across retries. Claim the local owner and verify direct and Shell login.
4. On VPS use the portable release image and standalone celld Compose configuration. Protect persistent storage and private operator credentials. Do not give the Client Docker/SSH access.
5. Verify UUID stability, local owner/member/invitation access, denial, messages, files, actual WebSocket authentication, logout revocation and separate backup/restore. Resource existence alone is not readiness.
6. Keep backups separate from live files and preserve backup buckets on Server deletion. Never replace published tags/assets or merged SQL.

Return the Server and Shell links, version and verified behavior. Save owner/recovery information in an ignored private file. Keep future hosted billing and global L4 identity outside the creation scope.
