---
title: Releases and updates
description: How L4 versions and releases work, and how each kind of Server (Cloudflare, VPS, Docker, Coolify) receives an update.
order: 5
---

L4 ships as numbered releases on [GitHub](https://github.com/inchidev/llll/releases). Your Server changes only when its operator chooses an update. Nothing updates it automatically.

## One shared version

One version number covers every part of L4: the Landing page, Shell and installer at llll.gg, the Server, the portable runtime image and the Docs. Release notes for each version are published with the release.

- **Stable releases** have a plain version, such as `0.3.4`.
- **Prereleases** have an alpha, beta or rc suffix, such as `0.2.0-alpha.7`. You must choose them explicitly.

## Releases are immutable

A published release tag and its files are never replaced. Every release includes a `SHA256SUMS` file. Installers and updaters check the checksums before they install anything, and they accept only published releases: never unreleased or locally built code.

If a release turns out to be wrong, the fix comes in a new version.

## Database lineage

Since 0.3.0, Servers use the `server-v2` database lineage. A 0.3.x Server needs a fresh database: 0.2.x Servers cannot be upgraded into it and stay on their selected release. Within the lineage, migrations are only added, never rewritten, and they apply automatically during an update.

Migrations only go forward. There is no automatic downgrade. To go back, restore a backup.

## How updates arrive

| Server | How to update |
| --- | --- |
| Cloudflare | **Server settings → Deployment → Updates** in the Server. |
| VPS installer | `sudo llll upgrade` on the VPS. |
| Docker Compose | Set a newer image in `LLLL_IMAGE` and restart the stack. |
| Coolify | Redeploy with `latest`, or change `LLLL_VERSION`. |

### Cloudflare

The Owner opens **Server settings → Deployment → Updates**, chooses a newer release and selects **Back up and update**. **Include prereleases** adds alpha, beta and rc releases to the list. Only releases newer than the running version can be chosen. No Git, GitHub account or Workers Builds is needed.

There are two ways the update runs:

- **On the Server.** If the Server keeps Cloudflare access (**Keep Cloudflare access on this Server**, on by default when installing), it updates itself. It verifies the release, writes a backup to the separate backups bucket and reads it back, uploads the release and lets the new version confirm itself. You can close the page. **Retry update** resumes after the verified backup.
- **Through the official installer.** Without kept access, Settings sends you to the installer at llll.gg, which asks for fresh Cloudflare consent, makes and verifies the backup, then uploads the release.

The update keeps the Server's bindings, secrets, UUID and Durable Objects. See [Update a Cloudflare Server](../cloudflare/updates.md).

![Server settings → Deployment → Updates on a Cloudflare Server with a newer release selected and the Back up and update button](screenshot:concepts-updates-cloudflare "Updating a Cloudflare Server")

### VPS installer

`sudo llll upgrade` installs the latest stable release. It takes a mandatory backup first and restores the previous version and data if the new one fails to start. See [VPS](../self-host/vps.md#upgrade).

### Docker Compose and Coolify

Stable releases are published as `ghcr.io/inchidev/llll:<version>`, `:<minor>` and `:latest`, for `linux/amd64` and `linux/arm64`. Prereleases are not published as images. On start, the container applies new migrations and refuses an image older than the release that last migrated its data.

In these Servers, **Server settings → Deployment → Updates** says that updates are managed outside L4 and shows when a newer stable release exists. See [Docker Compose](../self-host/docker.md#update) and [Coolify](../self-host/coolify.md#updates).

## After an update

When the new Client is ready, Settings offers to load the new interface. Check that Owner and Member login, permissions, files and realtime work, and that the Server UUID is unchanged.
