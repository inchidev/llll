---
title: Costs and limits
description: Which Cloudflare products an L4 Server uses, who pays for them, and the limits that apply on Cloudflare.
order: 3
---

L4 itself is free, MIT licensed software and has no hosted plan or billing. A Cloudflare Server runs in your own account, and Cloudflare bills that account directly for what the Server uses. L4 does not quote prices; check Cloudflare's current pricing for each product below.

## Products a Server uses

| Product | When | Cloudflare docs |
| --- | --- | --- |
| Workers, with static assets and a weekly cron trigger | Always | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| D1 | Always | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| Durable Objects | Always: realtime, presence, notifications, Agents, Runs, Schedules | [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| Workers KV | Always: connection tickets, and files with basic storage | [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/) |
| R2 | When R2 is enabled: the files bucket and the separate backups bucket | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| Workers AI | When an Agent or AI function uses a Workers AI model | [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) |
| Browser Rendering | When a feature reads a web page through it | [Browser Rendering](https://developers.cloudflare.com/browser-rendering/) |
| Email Routing and Email Sending | When you connect a mail domain | [Email Routing](https://developers.cloudflare.com/email-routing/) |
| Realtime (RealtimeKit) | When you connect Live | [Realtime](https://developers.cloudflare.com/realtime/) |
| Containers and Artifacts | When you enable a compute node for Agents | [Containers](https://developers.cloudflare.com/containers/) |

Cloudflare bills the optional products by usage, so they matter only once you set them up and use them. A compute node uses paid Containers and Artifacts; the installer asks you to confirm those charges before it provisions one.

Model Providers you connect, such as OpenRouter, Anthropic or ChatGPT, bill you separately.

### Backups take storage

With R2, the Server writes a backup to its backups bucket every week and before each update. L4 does not delete old backups, so the backups bucket grows over time. Delete archives you no longer need in the Cloudflare dashboard, and keep at least one recent one. See [Backups](backups.md).

## Free and paid Workers plans

A Server can start on a free Cloudflare account. Some limits are tighter on the Workers Free plan:

- A self-update from Settings runs in one Durable Object alarm. On Workers Free its subrequest budget is tight for releases with large asset changes. If an update stops, use **Retry update** or run the update through the official installer.
- Cloudflare's daily and per-request quotas for Workers, D1, KV and Durable Objects apply to the whole account. If you run several Servers in one account, they share those quotas.

See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) for the current numbers.

## L4 limits on Cloudflare

| Limit | Value |
| --- | --- |
| Basic file storage (no R2) | 20 MiB per file, 500 MiB in total. KV's own account limits and daily quotas also apply. |
| Mail attachments | Up to 10 attachments, 3 MB in total, per email. |
| Server name | Up to 80 characters. |
| Installer session | One hour, renewed only by connecting Cloudflare again. |

## Keep costs predictable

- Give each Server its own Cloudflare account. Usage and quotas then stay separate, and kept access reaches only that Server. A free account is enough.
- Enable optional products only when you need them.
- Set usage notifications in your Cloudflare account.
- Prune old backups in the backups bucket.
