---
title: L4 on Cloudflare
description: What the L4 installer creates in your Cloudflare account, how the resources are named, and which settings manage them afterwards.
order: 1
---

A Cloudflare Server runs entirely in your own Cloudflare account. The official installer at [llll.gg/create](https://llll.gg/create?tab=cloudflare) creates its resources through your Cloudflare authorization and uploads a published, checksum-verified release. There is no L4 service in between: Cloudflare bills your account directly, and the Server owns its Accounts, files and conversations.

To install one, follow [Create a Server on Cloudflare](../get-started/create-on-cloudflare.md).

## What the installer creates

The installer generates a UUIDv4 for the new Server and uses it in every resource name. The same UUID is the Server's identity.

| Resource | Name | Purpose |
| --- | --- | --- |
| Worker | `llll-<uuid>` | Runs the Server and serves its Client, with static assets. |
| D1 database | `llll-<uuid>-db` | Accounts, Members, Roles, messages, Tasks, settings and the file index. |
| Workers KV namespace | `llll-<uuid>-tickets` | Short-lived connection tickets. Also holds files when the Server uses basic file storage. |
| R2 bucket (files) | `llll-<uuid>-files` | Private live files. Created when R2 is enabled. |
| R2 bucket (backups) | `llll-<uuid>-backups` | Backups, kept separate from live files. Created when R2 is enabled. |
| Durable Objects | Namespaces in the Worker | Realtime channels, presence, rate limits, notifications, Agents, Runs and Schedules. |
| `workers.dev` address | `llll-<uuid>.<your-subdomain>.workers.dev` | The Server's first address. |
| Cron trigger | Weekly | Weekly backup and renewal of kept Cloudflare access. |

The Worker also gets bindings for Workers AI and Browser Rendering. Cloudflare bills those products by usage, for example when an Agent uses a Workers AI model; see [Costs and limits](costs-and-limits.md).

The installer creates no custom domain, DNS record or mail configuration. You add those later from the Server's Settings. See [Custom domain](custom-domain.md) and [Mail](mail.md).

### Without R2

Before it allocates anything, the installer checks whether R2 is enabled on the account. If it is not, the Server uses **basic file storage**: files are stored in the KV namespace with a limit of 20 MiB per file and 500 MiB in total, and there is no separate backups bucket, so backups download to your device.

You can add R2 later in **Server settings → Storage → Connect R2**, then move existing files with **Move files to R2**. The copy is verified, and the original KV copies are kept.

## What the Server keeps

After installation the Worker holds only a few settings: its primary address, a random `AUTH_SECRET`, the authentication mode, the Cloudflare account ID and its resource bindings. The Server name, registration mode and mail settings live in D1. Changing the Server name in Settings never touches Cloudflare resources.

The Owner setup claim is stored only as a digest in D1 and is deleted when the Owner claims the Server.

If you leave **Keep Cloudflare access on this Server** on (the default), the Server also stores a Cloudflare credential, encrypted with its `AUTH_SECRET`. See [Cloudflare access](access.md).

## Where to manage it

In the Server, the Owner finds the Cloudflare deployment under **Server settings → Deployment**:

| Tab | What it does |
| --- | --- |
| **Overview** | Shows the Server address and the Worker name. |
| **Domain** | Server addresses: add, make primary, remove. See [Custom domain](custom-domain.md). |
| **Backups** | Download a backup or save one to an S3-compatible bucket. See [Backups](backups.md). |
| **Updates** | Cloudflare access and updates. See [Updates](updates.md). |
| **Remove** | How to remove the Server. See [Remove a Server](remove-a-server.md). |

File storage is under **Server settings → Storage**, and mail domains under **Server settings → Mail**.

![The Deployment settings with the Overview, Domain, Backups, Updates and Remove tabs, showing the Server address and Runtime](screenshot:cloudflare-deployment-settings "Server settings → Deployment on a Cloudflare Server")

## One Server per Cloudflare account

You can create several Servers in one account; the installer lists every L4 Server it finds there under **Your Servers**. For safety, we recommend giving each Server its own Cloudflare account. A free account is enough. A credential kept on one Server then reaches only that Server's resources. This is a recommendation, not a requirement.

## Related

- [Cloudflare access](access.md)
- [Costs and limits](costs-and-limits.md)
- [Updates](updates.md)
