---
title: Compute Nodes
description: Give Agents an isolated place to work on repository Tasks, on your own VPS, in your own Cloudflare account or, coming, with L4 Compute by the hour.
order: 4
---

A Compute Node is where an Agent's repository work runs. When an Agent works on a repository-backed Task, the Server sends workspace operations (read files, run commands, commit) to a connected Compute Node. The Agent's model and tools stay on the Server; the Node only runs the workspace. Without a connected Node, repository metadata is still available, but Agents cannot write code.

This page covers setting up compute. For how Agents use it, see [Repositories](../agents/repositories.md).

## Choose a kind of compute

Open **Server settings → Compute** (requires Manage server). **Add compute** offers three paths: **Your own VPS** (Connect node), **Your own Cloudflare** (Server compute setup) and **L4 Compute**, which is coming. The **Server compute setup** entry shows the option that fits where your Server runs. The Server speaks one Node protocol to all of them; only where the Node runs differs.

| Option | Where it runs | Good for |
| --- | --- | --- |
| VPS local executor | Docker on the same VPS as a [VPS installer](vps.md) Server | A single trusted VPS. |
| Cloudflare Containers | Your Cloudflare account, next to a Cloudflare Server | Cloudflare Servers on Workers Paid. |
| Remote Docker Node | Any Linux Docker host you pair | Advanced setups, and any machine you rent yourself. |
| L4 Compute (coming) | A box per Task from llll.gg, paid by the hour of agent work | Compute without running a machine yourself, however many Agents work at once. |

The workspace is free wherever you run it. L4 sells only Managed Compute; see [Pricing](https://llll.gg/pricing).

> [!WARNING]
> Docker workspaces share the host's kernel. Use them only for code and people you trust. They are not a boundary against hostile tenants.

## VPS local executor

On a VPS installer Server, add the executor during install with `LLLL_FACTORY=true LLLL_SHARED_KERNEL_TRUSTED=1`, or later:

```bash
sudo llll compute enable --trust-shared-kernel
```

`llll factory` is the same command. The CLI downloads the verified Compute Node and workspace image from the release, checks the host, installs a root systemd service and pairs it with the Server automatically after the Owner is claimed. No Git clone, source build or registry is needed.

The host needs:

- Linux amd64 with local Docker.
- At least 17 GiB free disk and 2 GiB available RAM beyond what the Server uses. Each new Task workspace gets a 10 GiB disk.
- Loop-device and mount support (`fallocate`, `mkfs.ext4`, `mount`, `umount`, `findmnt`, `losetup`).
- systemd as process 1.

Manage it with:

```bash
sudo llll compute status
sudo llll compute logs
sudo llll compute restart
sudo llll compute disable
sudo llll compute backup
sudo llll compute remove --keep-source
```

`disable` and `remove --keep-source` keep Task disks and receipts. Compute backups are separate from the Server backup made by `llll backup`; copy them encrypted off the host.

### Hosts without systemd

In a container or on a host whose process 1 is not systemd, add `--no-systemd`. The CLI prepares the same verified files and writes `factory/factory.env`; you start the Node yourself:

```bash
set -a; . /opt/llll/factory/factory.env; set +a
/opt/llll/factory/releases/VERSION/node /opt/llll/factory/releases/VERSION/src/pair-local.mjs /opt/llll/.env
/opt/llll/factory/releases/VERSION/node /opt/llll/factory/releases/VERSION/src/daemon.mjs
```

In that mode `status` and `logs` fail with an explanation instead.

## Cloudflare Containers

A Cloudflare Server can run compute in the same Cloudflare account. Open **Server settings → Compute → Server compute setup** and choose **Enable compute node in Cloudflare**, which opens the official installer with a fresh Cloudflare consent. This needs Workers Paid and available Containers and Artifacts access; the installer never changes your plan. Review the charges, choose compute size, command time and process limits, then return to Settings, confirm the authorization and choose **Activate compute node**.

Each Task gets its own code repository. Compute stops after each checkpoint, one operation runs at a time and there is no nested Docker. **Pause compute node and retain source** stops new work and keeps source. See [Costs and limits](../cloudflare/costs-and-limits.md) and Cloudflare's [Containers pricing](https://developers.cloudflare.com/containers/pricing/).

## Remote Docker Node

You can pair any trusted Linux Docker host with the Server. The Node connects out to the Server; the Server needs no inbound route to it. This works for both Cloudflare and VPS Servers.

1. In **Server settings → Compute → Add compute → Connect node**, name the node and choose **Create pairing code**. The code works once and expires after ten minutes.
2. On the host, build the workspace image from the release you run, push it to your own registry and note its immutable digest. The Node refuses mutable tags.

   ```bash
   docker build -f packages/compute-node/Dockerfile.workspace -t YOUR_REGISTRY/l4-workspace:VERSION .
   docker push YOUR_REGISTRY/l4-workspace:VERSION
   docker image inspect YOUR_REGISTRY/l4-workspace:VERSION --format '{{json .RepoDigests}}'
   ```

3. Start the Node from a checkout of the same release, entering the pairing code without saving it in shell history:

   ```bash
   export LLLL_SERVER_ORIGIN=https://YOUR_SERVER
   export LLLL_NODE_STATE=/PRIVATE/COMPUTE_STATE
   export LLLL_WORKSPACE_IMAGE=YOUR_REGISTRY/l4-workspace@sha256:DIGEST
   export LLLL_SHARED_KERNEL_TRUSTED=1
   read -r -s -p 'One-use pairing code: ' LLLL_PAIRING_TOKEN
   export LLLL_PAIRING_TOKEN
   sudo --preserve-env=LLLL_SERVER_ORIGIN,LLLL_NODE_STATE,LLLL_WORKSPACE_IMAGE,LLLL_SHARED_KERNEL_TRUSTED,LLLL_PAIRING_TOKEN node packages/compute-node/src/daemon.mjs
   ```

The Node needs Node.js 24, Docker and the loop/mount tools listed above, and runs as root. A remote Server must use HTTPS. Later starts reuse the stored connection and need no pairing code; keep `LLLL_SERVER_ORIGIN` set on every start. No public port is opened.

The full threat model and limits are in the [Compute Node guide](https://github.com/inchidev/llll/blob/main/docs/software-factory.md).

## L4 Compute (coming)

L4 Compute is elastic: llll.gg starts an isolated box for each Task that needs one, pairs it with your Server, and stops it when the Task's work is done. You pay by the hour of agent work, billed by the minute (each box run rounds up to the next minute, one minute at least), nothing while no Agent works, and there is no limit on how many Agents work at once. It is not available yet. A self-hosted Server will use it exactly like a Cloud Server, from **Server settings → Compute → Add compute**, signing in with your llll.gg account: no API key and no environment variable. Until then, a machine you rent from any provider is a VPS to the Server; install the Node on it as above. See [Pricing](https://llll.gg/pricing).

## Check a Node

Select a Node in **Server settings → Compute** to see whether it is **Connected**, **Offline** or **Disabled**, when it was last seen, its disk, parallel operations and image. **Disable and revoke** stops it from taking new work.

![Server settings → Compute with the Server compute setup entry and one connected Docker Node](screenshot:self-host-compute-list "Compute in Server settings")

To replace a Node, for example after changing its image: export or finish retained work, disable and revoke the old Node, pair a new one, update the repository environment and start new Tasks.
