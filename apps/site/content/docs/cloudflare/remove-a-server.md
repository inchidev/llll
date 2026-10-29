---
title: Remove a Cloudflare Server
description: Remove an L4 Server from your Cloudflare account safely, keeping its backups, and clean up domains, mail and kept access.
order: 8
---

L4 does not delete Servers for you. You remove a Cloudflare Server's resources yourself in your Cloudflare account, after saving a backup. Backups are never deleted with a Server; keep them until you are sure you no longer need them.

> [!WARNING]
> Removing a Server permanently deletes its Accounts, conversations, files and settings for everyone. Members lose access. Make and keep a backup first.

## 1. Find the Server's resources

In your Server, open **Server settings → Deployment → Overview**. **Runtime** shows the Worker name, `llll-<uuid>`. Every resource of this Server uses the same UUID:

| Resource | Name | Remove? |
| --- | --- | --- |
| Worker | `llll-<uuid>` | Yes |
| D1 database | `llll-<uuid>-db` | Yes |
| KV namespace | `llll-<uuid>-tickets` | Yes |
| R2 files bucket | `llll-<uuid>-files` | Yes, if it exists |
| R2 backups bucket | `llll-<uuid>-backups` | **No. Keep it.** |

A Server created by an older release may use a different Worker name; the Overview tab always shows the real one.

## 2. Make a backup

1. Open **Server settings → Deployment → Remove** and select **Review backups**, or go to **Server settings → Deployment → Backups**.
2. Select **Download backup**, or save one to a separate S3-compatible bucket.
3. Keep the archive somewhere safe.

See [Backups](backups.md).

![The Remove server tab with the notice that removal is handled by the deployment operator and the Review backups button](screenshot:cloudflare-remove-server "Server settings → Deployment → Remove")

## 3. Clean up while the Server still runs

If the Server keeps Cloudflare access, do these from its Settings first, so it removes its own Cloudflare configuration. Otherwise, mail domains and aliases are removed through the installer or by you in Cloudflare (step 4).

1. **Mail domains.** In **Server settings → Mail → Domains**, select **Disconnect** for each domain.
2. **Aliases.** In **Server settings → Deployment → Domain**, select **Remove** on each alias. The primary address cannot be removed here; check for it in step 4.
3. **Kept Cloudflare access.** In **Server settings → Deployment → Updates**, select **Disconnect** on the **Cloudflare access** card.

## 4. Delete the resources in Cloudflare

In the Cloudflare dashboard for the Server's account:

1. Delete the Worker `llll-<uuid>`.
2. Delete the D1 database `llll-<uuid>-db`.
3. Delete the KV namespace `llll-<uuid>-tickets`.
4. Delete the R2 bucket `llll-<uuid>-files`, if there is one.
5. Check your zone for anything left over for this Worker: Workers custom domains, Email Routing rules that send to it, and Email Sending configuration for its mail domains.

Keep the R2 bucket `llll-<uuid>-backups` and any downloaded archives.

> [!NOTE]
> Deleting the Worker also deletes its `AUTH_SECRET`. Settings that the Server encrypted with it, such as provider keys, cannot be decrypted from a backup afterwards.

## 5. Revoke Cloudflare access

- If the Server kept the installer's OAuth grant, revoke L4's authorization in your Cloudflare profile.
- If you connected an API token, delete that token in the Cloudflare dashboard.

## 6. Remove the bookmark from devices

Saved Servers are bookmarks on each device. When a saved `workers.dev` address no longer has a Worker, the Shell notices and removes it from that device. A Server saved under a custom domain is never removed automatically: select **Remove from this device** in `/create`, or the **×** next to it under **Saved on this device**.

## Pause instead of removing

An unfinished installation you no longer want is not removed by **Pause and start another** or by disconnecting Cloudflare. Pausing keeps its resources so you can resume. Delete them in Cloudflare the same way, and keep any backups.
