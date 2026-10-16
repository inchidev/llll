---
name: llll-create-server
description: Create or verify a self-hosted L4 server in a user's Cloudflare account through the managed installer, with optional Cloudflare MCP or Wrangler support. Use when the user asks to install, deploy, create, update, or verify a L4 server; not for ordinary development or for using an existing workspace.
---

# Create a L4 server

Use L4's managed installer as the default path. One L4 installation and URL contain one workspace.

## Managed installation

1. Open `https://llll.gg/admin`.
2. Let the user complete Cloudflare OAuth. Never ask them to paste a Cloudflare API token into chat.
3. Help select the intended Cloudflare account, active zone, app subdomain, email subdomain, first mailbox address, and owner email. Ask only for choices that cannot be inferred safely.
4. Submit the installation and allow it to provision the Worker, storage, Durable Objects, hostname, email routing, bindings, and bootstrap state.
5. Do not bypass installer conflict checks or replace an existing Worker hostname, non-Cloudflare MX records, or another catch-all email route.
6. Return the private one-time owner setup link to the user. Treat the claim in that link as sensitive and do not repeat it in logs or unrelated output.
7. After setup, verify the deployed origin through `/api/setup/health`. Report installation, owner setup, and runtime verification as separate states.

The installed Worker must not retain the temporary Cloudflare OAuth token. Updates are initiated by the user; do not claim background automatic updates.

## Existing installation update

Use **Workspace Settings → Updates** or rerun the managed installer. Preserve the existing hostname and bound D1, R2, and KV resources. Before an update with pending migrations, tell the owner that the installer does not create an automatic backup and offer the documented backup flow. Verify the reported version and health after deployment.

## Cloudflare tools

If an authenticated Cloudflare plugin or MCP server is available, use it only for useful preflight inspection or post-install verification unless the user explicitly requests a manual deployment. The skill must remain usable without that plugin by directing the user to the managed installer.

For a manual or source-based deployment:

1. Read the current deployment guide at `https://github.com/inchidev/llll/blob/main/docs/deployment.md` before acting.
2. Use the current public repository at `https://github.com/inchidev/llll`.
3. Use Cloudflare-specific skills or current Cloudflare documentation for API, Wrangler, binding, and migration details.
4. Obtain authorization immediately before mutations. Do not infer permission to replace domains, DNS, email routes, data, or an existing Worker.
5. Verify code/build, provisioned resources, deployed runtime, and browser behavior separately. A successful build or API call alone is not deployment proof.

## Failures and retries

Before retrying a failed write, inspect the installer result, current Cloudflare resources, and `/api/setup/health` so an uncertain response does not create duplicate resources. Stop and ask the user when the intended account, zone, domain, or conflicting resource cannot be resolved safely.

## Completion

Summarize:

- the server URL;
- whether Cloudflare provisioning completed;
- whether owner setup completed;
- the runtime health result;
- any remaining user action.

Do not describe a server as ready while owner setup or runtime verification is still incomplete.
