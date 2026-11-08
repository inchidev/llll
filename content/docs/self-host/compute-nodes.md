---
title: Compute Nodes
description: Give Agents an isolated place to work on repository Tasks, on your own VPS, in your own Cloudflare account or with L4 Compute by the hour.
order: 4
---

A Compute Node is where an Agent's repository work runs. Each repository-backed Task gets one **box** on a Node: a container with a Git checkout where the Agent edits, runs commands and commits on its own, without asking the Server for each command. The model's keys stay on the Server; the box reaches the model through it. Without a connected Node, repository metadata is still available, but Agents cannot run code.

This page covers setting up compute. For how Agents use it, see [Repositories](../agents/repositories.md).

## Choose a kind of compute

Open **Server settings → Compute** (requires Manage server). **Add compute** offers three paths: **Your own VPS** (Connect node), **Your own Cloudflare** (Server compute setup) and **L4 Compute** (Add L4 Compute). The **Server compute setup** entry shows the option that fits where your Server runs. The Server speaks one Node protocol to all of them; only where the Node runs differs.

| Option | Where it runs | Good for |
| --- | --- | --- |
| VPS local executor | Docker on the same VPS as a [VPS installer](vps.md) Server | A single trusted VPS. |
| Cloudflare Containers | Your Cloudflare account, next to a Cloudflare Server | Cloudflare Servers on Workers Paid. |
| Remote Docker Node | Any Linux Docker host you pair | Advanced setups, and any machine you rent yourself. |
| L4 Compute | A box per Task from llll.gg, paid by the hour of agent work | Compute without running a machine yourself, however many Agents work at once. Available on every Server once linked. |

The workspace is free wherever you run it. L4 sells only Managed Compute; see [Pricing](https://llll.gg/pricing).

> [!WARNING]
> Docker boxes share the host's kernel. Use them only for code and people you trust. They are not a boundary against hostile tenants.

## VPS local executor

On a VPS installer Server, add the executor during install with `LLLL_FACTORY=true LLLL_SHARED_KERNEL_TRUSTED=1`, or later:

```bash
sudo llll compute enable --trust-shared-kernel
```

`llll factory` is the same command. The CLI downloads the verified Compute Node and box image from the release, checks the host, installs a root systemd service and pairs it with the Server automatically after the Owner is claimed. No Git clone, source build or registry is needed.

The host needs:

- Linux amd64 with local Docker.
- At least 17 GiB free disk and 2 GiB available RAM beyond what the Server uses. Each Task's box gets a 10 GiB disk, kept until the Task is Done.
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

`disable` and `remove --keep-source` keep Task disks. Compute backups are separate from the Server backup made by `llll backup`; copy them encrypted off the host.

### Update the executor

The executor always runs the same release as its Server. `sudo llll upgrade` replaces it with the new release's Compute Node and box image once the Server is updated and healthy. You can also run `sudo llll compute enable --trust-shared-kernel` at any time, for example to retry. The executor keeps its pairing, its boxes and their Task disks, and settings such as `LLLL_NODE_BOXES`. If the replacement fails, the Server stays updated and the command to retry is printed. A Node you disabled and revoked in Settings stays off.

An executor from before 0.0.10 also leaves the workspace disks of the old per-command Factory in `/opt/llll/factory/state/workspace-disks`. No Task uses them now. `sudo llll compute release-old-disks` lists them; export them with `sudo llll compute backup`, then delete them with `sudo llll compute release-old-disks --yes`.

### Hosts without systemd

In a container or on a host whose process 1 is not systemd, add `--no-systemd`. The CLI prepares the same verified files and writes `factory/factory.env`; you start the Node yourself:

```bash
set -a; . /opt/llll/factory/factory.env; set +a
/opt/llll/factory/releases/VERSION/node /opt/llll/factory/releases/VERSION/src/pair-local.mjs /opt/llll/.env
/opt/llll/factory/releases/VERSION/node /opt/llll/factory/releases/VERSION/src/daemon.mjs
```

In that mode `status` and `logs` fail with an explanation instead.

## Cloudflare Containers

A Cloudflare Server can run compute in the same Cloudflare account. Open **Server settings → Compute → Server compute setup** and choose **Enable compute node in Cloudflare**, which opens the official installer with a fresh Cloudflare consent. This needs Workers Paid and available Containers and Artifacts access; the installer never changes your plan. Review the charges, choose the box size, how many boxes may run at once (4 by default) and the process limit, then return to Settings, confirm the authorization and choose **Activate compute node**.

Each Task's box is one container with its own code repository in Artifacts. Its work is checkpointed there when a turn ends, and the box stops after 10 minutes without a turn; dependencies and build output are not kept between starts. There is no nested Docker. **Pause compute node and retain source** stops the boxes and keeps their checkpoints. See [Costs and limits](../cloudflare/costs-and-limits.md) and Cloudflare's [Containers pricing](https://developers.cloudflare.com/containers/pricing/).

## How many boxes run at once

A Node announces its capacity, and the Server runs as many boxes as fit. A VPS Node runs one box per CPU while each still gets 1 GiB of memory, with an equal share of CPU and memory each; set `LLLL_NODE_BOXES` (1 to 64) in its environment to run fewer, for a host that also does other work. A Cloudflare Node runs the number of boxes chosen at setup. A Task whose box does not fit waits and shows **Waiting for a free box**. On a VPS a box stops after 15 minutes without work; its disk stays until the Task is Done.

## Remote Docker Node

You can pair any trusted Linux Docker host with the Server. The Node connects out to the Server; the Server needs no inbound route to it. This works for both Cloudflare and VPS Servers.

1. In **Server settings → Compute → Add compute → Connect node**, name the node and choose **Create pairing code**. The code works once and expires after ten minutes.
2. On the host, build the box image from the release you run, push it to your own registry and note its immutable digest. The Node refuses mutable tags.

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

## L4 Compute

L4 Compute is elastic: llll.gg starts an isolated box for each Task that needs one, pairs it with your Server, and stops it when the Task is Done. You pay by the hour of agent work, billed by the minute (each box run rounds up to the next minute, one minute at least), nothing while no Agent works, and there is no limit on how many Agents work at once. Every Server can use it, on your own Cloudflare account, on a VPS or on L4 Cloud. See [Pricing](https://llll.gg/pricing).

### Link the Server

In **Server settings → Compute**, the Owner chooses **Add L4 Compute**. The browser goes to llll.gg, where you sign in (or create an account) and allow this Server; llll.gg returns you to the Server, which from then on holds a Server token for your account, encrypted like its other secrets. The Compute page shows **Linked to llll.gg account …** with **Disconnect**. There is no API key and no environment variable, and nothing is linked by an email address: only this step links a Server. A Server hosted on L4 Cloud is linked by itself and shows no connect step.

Once linked, **L4 Compute** appears as a Compute Node the Server's repositories can choose, next to your VPS Node or Cloudflare Containers. Choose it when connecting a repository, or in **Server settings → Git** for an existing one.

### A box per Task

When a Task on such a repository starts, the Server asks llll.gg for a box of the Project's size and gives it a one-use pairing code bound to that Task. The box is a microVM of its own, for one Task of one Server; it pairs itself with the Server and runs the published Compute Node, so the Agent sees an ordinary Node with a durable disk, kept until the Task is Done. On the Compute page each running box is listed under **L4 Compute** as its own Node; **Release this box** stops it early. When the Task is Done or archived, the Server tells llll.gg to stop and release the box, and billing for it ends.

Set the box size per Project on the Project page, under **L4 Compute box size**: **Small** (the default), **Medium** or **Large**. It applies to the next box of that Project. Prices for each size are on [Pricing](https://llll.gg/pricing).

### Credit and the spend limit

You buy credit and set a monthly spend limit on your [llll.gg account](https://llll.gg/account). The Compute page shows the credit, what this month has spent and the limit as llll.gg reports them, refreshed about every minute. When llll.gg cannot be reached, the page says **llll.gg unreachable** and keeps the last answer; boxes already running are not affected, and nothing on the Server waits for it.

When a Task needs a box and the account has no credit or has reached its monthly limit, llll.gg refuses the box and the Task shows **Needs L4 Compute credit** with a link to buy credit. Nothing is retried for you: buy credit or raise the limit, then start the Task again.

### Disconnect

**Disconnect** releases every box of this Server on L4 Compute, forgets the Server token and pauses the **L4 Compute** Node. Repositories placed on it need another Node, or a new link, before Agents can work on them again. Linking again revives the same Node, so their choice stands.

## Check a Node

Select a Node in **Server settings → Compute** to see whether it is **Connected**, **Offline** or **Disabled**, when it was last seen, its disk per box, how many boxes it runs at once and its image. **Disable and revoke** stops it from taking new work.

![Server settings → Compute with the Server compute setup entry and one connected Docker Node](screenshot:self-host-compute-list "Compute in Server settings")

A box from L4 Compute comes with the published Compute Node, so it never shows this.

A Node of an earlier release shows **Needs this release’s Compute Node** and gets no work until it is updated. Selecting it says what to do: for the VPS local executor, run `sudo llll compute enable --trust-shared-kernel`, which replaces it in place. A remote Docker Node is replaced: stop its daemon, disable and revoke it, pair this release's Node with a new code, select it in the repository environment and start new Tasks. Do the same to change a remote Node's image.
