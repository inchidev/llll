---
title: Install on a VPS
description: Install an L4 Server on your own Debian or Ubuntu VPS with one command, then claim it as Owner.
order: 4
---

The VPS installer runs one L4 Server on your machine with Docker Compose and HTTPS through Caddy. It installs a pinned, checksum-verified release and never builds source code on the VPS.

This page is the short path. For operations, backups, restore and configuration, see [VPS](../self-host/vps.md).

## Before you start

- A dedicated **amd64** VPS with Debian 12 or 13, or Ubuntu 22.04 or 24.04, at least 2 GiB RAM and 5 GiB free disk.
- A **domain** whose A/AAAA records point at the VPS. A domain is required; there is no fallback hostname.
- Inbound TCP ports **80** and **443** open.
- Root access (`sudo`).

If Docker is missing, the installer installs Docker Engine and Compose from Docker's official repository. An existing Docker needs Engine 24 or newer and Compose 2.24.4 or newer; it is never replaced.

## 1. Get the install command

1. Open [llll.gg/create](https://llll.gg/create?tab=vps) and choose the **New on a VPS** tab.
2. Enter **Server domain**, for example `chat.example.com`.
3. Enter **Owner email**.
4. Optional: check **Let agents run code on this VPS** to add a compute node, then confirm **I trust the code and people using this VPS.** See [Compute nodes](../self-host/compute-nodes.md).
5. Select **Copy**.

![The New on a VPS tab with the Server domain and Owner email fields filled in and the generated install command with its Copy button](screenshot:get-started-vps-command "Copy the install command")

The command looks like this:

```bash
curl -fsSL https://llll.gg/install.sh | sudo env \
  LLLL_DOMAIN='chat.example.com' \
  LLLL_ADMIN_EMAIL='you@example.com' \
  bash
```

## 2. Run it on the VPS

Run the command on the VPS as root. The installer verifies the release, sets up the Server in `/opt/llll`, waits for HTTPS and checks that the Server answers at your domain.

When it finishes, it prints a private link ending in `/setup#claim=…`.

> [!WARNING]
> The setup link is private. Anyone who has it can claim your Server before you do. Do not paste the terminal output into shared logs or chats.

## 3. Claim the Server as Owner

1. Open the printed link in your browser.
2. Enter **Your name**, a **Password** and **Confirm password**.
3. Select **Sign in as owner**.

Then add the Server to your Shell if you want: see [Connect to a Server](connect-a-server.md).

## If something fails

Fix the cause, such as DNS or a closed port, and run the same command again. Rerunning the installer keeps the existing configuration, credentials and Server UUID.

Check status and logs with:

```bash
sudo llll status
sudo llll logs
```

## Next steps

- [Invite your team](invite-your-team.md)
- [Back up, upgrade and add domains on the VPS](../self-host/vps.md)
