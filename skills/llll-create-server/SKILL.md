---
name: llll-create-server
description: Create or verify an L4 installation and its isolated servers on Cloudflare or celld. Use for explicit install/deploy/create/update requests, not ordinary code changes.
---

# Deploy L4

Read the current `docs/instance.md` and `docs/deployment.md`. An installation owns accounts and a server directory; every server has separate resources. There is no separate Admin application. The optional site provides a Cloudflare OAuth installer with a temporary credential handoff.

1. Establish the target installation, provider and existing state. Use ignored deployment configuration and private credentials; do not ask for tokens in chat or print claims/secrets.
2. For Cloudflare, bootstrap the installation through the documented source installer. Its owner can then configure a scoped API token in Instance settings to provision servers, or register separately deployed servers. Agent account operations use the connected Cloudflare API tool; local Wrangler is for validation unless the user explicitly authorizes an exception.
3. For VPS, generate private celld Compose configuration, deploy it through the operator's Docker/Coolify setup, create the owner with the private claim link and register its servers. The web app has no Docker socket.
4. Preserve existing D1, files, backups, pairing/encryption secrets and deployment state. After an uncertain operation, inspect current state before retrying.
5. Verify installation discovery/owner login, server membership, independent resources, files and realtime separately. A successful resource creation alone is not proof that the installation is ready.
6. Before updates, back up control data/secrets and server data. Published releases and migration SQL are immutable. VPS updates and resource deletion are operator actions.

The Cloudflare OAuth installer requires a configured public PKCE client and a verified published release. Its Cloudflare grant is separate from local Account/Telegram authentication. The initial alpha is for fresh databases; never apply its baselines to an archived prototype database. Return the installation/client address, setup and verification status, and any remaining credential/provider step. Keep private claim and recovery information out of public artifacts.
