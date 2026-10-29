---
title: Choose how to run your Server
description: Compare running an L4 Server on your Cloudflare account with running it on your own VPS, and pick the path that fits you.
order: 2
---

Every L4 Server runs on infrastructure you control. There are two targets: your **Cloudflare account** or a **VPS** you manage. Both run the same published release, and in both the Server owns its Accounts, files and conversations.

If you only want to join a Server someone else runs, you do not need either. See [Connect to a Server](connect-a-server.md).

## At a glance

| | Cloudflare | VPS |
| --- | --- | --- |
| How you install | In the browser at `/create`, tab **New on Cloudflare** | One command on the VPS, from `/create`, tab **New on a VPS** |
| What you need | A Cloudflare account | A Debian or Ubuntu amd64 VPS and a domain pointed at it |
| First address | `<worker>.<your-subdomain>.workers.dev` | Your own domain, with HTTPS from Caddy |
| Custom domains | In Server Settings, for zones in the same Cloudflare account | `sudo llll domain` on the VPS |
| Updates | From Server Settings, or through the official installer | `sudo llll upgrade` on the VPS |
| Backups | Weekly and before each update, to a separate R2 bucket | `sudo llll backup`, kept on the VPS (copy them off-host) |
| Who pays | Cloudflare bills your account directly | Your VPS provider |

## Cloudflare

Choose Cloudflare if you want no server to maintain. The installer at [llll.gg/create](https://llll.gg/create?tab=cloudflare) connects to your Cloudflare account through OAuth, verifies a published release and creates the Server's Worker, database and storage in your account. You do not need Git, GitHub or a Workers Builds token.

Cloudflare is the path L4 verifies first. After installation the Server can keep Cloudflare access and update itself from its own Settings.

Start here: [Create a Server on Cloudflare](create-on-cloudflare.md). For the full picture, read the [Cloudflare overview](../cloudflare/overview.md).

> [!TIP]
> For safety, give each Server its own Cloudflare account. A free account is enough. This is a recommendation, not a requirement.

## VPS

Choose a VPS if you already run servers, want everything on one machine, or want agents to run code on that machine. The installer sets up Docker Compose, HTTPS through Caddy and the Server, then prints a private link where you choose the Owner password.

Start here: [Install on a VPS](install-on-a-vps.md). Docker Compose and Coolify are also possible; see [Docker](../self-host/docker.md) and [Coolify](../self-host/coolify.md).

## You can run more than one

Each Server is independent. You can create several Servers, on either target, and keep them all in your Shell. A Member of one Server has no access to another.
