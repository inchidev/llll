# How an L4 installation works

An installation is your independently deployed L4 service at one address. It owns accounts, login methods, sessions, invitations and a directory of servers. A server is one community with its own data and runtime. There is no separate Admin application to deploy.

```text
Your installation — controller Worker + control D1 + its own client
  ├─ Server A — Worker + D1 + private files R2 + KV + Durable Objects
  └─ Server B — Worker + D1 + private files R2 + KV + Durable Objects
Separate backup destination
```

One person has one account per installation and can join several servers. A server stores its own member profile, roles, permissions and removal status. Joining one server grants no access to another. An optional shared L4 OIDC account can be explicitly linked to an installation account; local password login remains available. Matching email addresses never silently merge identities.

## Create an installation

On Cloudflare, an operator runs the source installer with a Cloudflare account ID and API token in an ignored environment file. It creates the controller Worker, control D1, separate backup bucket and client assets. Open the private setup link to create the first installation owner. See [deployment.md](deployment.md#cloudflare) for commands.

On a VPS, generate the private celld Compose configuration and start it through Docker Compose or Coolify. Open the generated owner claim link, create the installation owner and register its deployed servers. See [deployment.md](deployment.md#vps-docker-compose-and-coolify).

Creating an installation is an operator deployment action. The public L4 site and shared client do not create installations for visitors, and the shared identity service does not provision infrastructure.

## Create servers inside it

Open the installation's `/connections` page as its owner. Configure the Cloudflare account ID and API token under **Installation settings**, then use **Create a server**. The controller provisions separate server resources and pairs the server with this installation. The same page can register a server that its operator deployed separately.

On VPS, add the server service through your private Compose/operator configuration, deploy it and register it with the installation. The web client has no Docker socket or host-level deployment access.

## Where credentials live

| Credential | Holder and purpose |
| --- | --- |
| Bootstrap Cloudflare API token | Operator environment; used by the source installer to create the installation. The installer does not automatically save it into the running installation. |
| Installation provisioning API token | Optional installation deployment secret or encrypted `integration_settings` record in control D1. Used by the controller to create/update servers. |
| Pairing key | A distinct key shared by the controller and one server; signs short-lived identities for that server only. It is not a Cloudflare API token. |
| Server provider credentials | Server deployment secrets or encrypted server settings for optional mail, calls and other integrations. |
| Account passwords and recovery keys | Password/recovery hashes live in the installation's control D1. Save owner recovery information privately. |

The owner UI returns credential configuration status, never saved token plaintext. Deployment-provided credentials override settings stored in D1. Keep the installation `AUTH_SECRET` backed up with control D1 so encrypted credentials remain readable.

Cloudflare OAuth onboarding is not implemented in L4. There is no working `llll.gg/admin` installer or central OAuth callback. Telegram/L4-account OIDC login authenticates people; it does not authorize Cloudflare provisioning.

## Clients and sites

The common client connects directly to independent installations over HTTPS/WebSocket. Each installation also serves the same client, so the common client is optional. Chat is rendered directly, without iframes. The left rail groups servers by installation; a server switch reloads the client and clears connection-specific runtime state.

| Source | Role | Deploy cycle |
| --- | --- | --- |
| `apps/site` | Public L4 landing | Independent static-site Worker |
| `apps/client` | Common client | Independent client Worker |
| `apps/installation` | Accounts, sessions, invitations, directory and server provisioning | Per installation |
| Root Nuxt/Nitro app | Server content, authorization and realtime | Per server |
| `packages/deployment-core` | Cloudflare server provisioning/update library | Built into the installation; not another service |

The previous `discoflare-com` repository and deployment belong to the previous product. L4 has no runtime dependency on them. Existing old deployments and callbacks are not migrated or redirected by an L4 update.

## Current operational boundaries

Cloudflare server updates can run through the installation after its owner configures provisioning credentials; the normal update flow backs up server data and installation metadata first. VPS updates, domain routing and resource removal belong to the operator. Server calls/mail require their own configured providers. Keep backups outside live file buckets and preserve both the installation and server layers.
