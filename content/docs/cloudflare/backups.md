---
title: Backups on Cloudflare
description: How a Cloudflare L4 Server backs up its database and files, where backups are kept, and how to make one yourself.
order: 7
---

A Backup is a recovery copy of your Server, stored separately from its live files. It is not a second running Server. L4 never deletes backup buckets together with a Server.

## Automatic backups

When R2 is enabled, the installer creates a separate backups bucket named `llll-<uuid>-backups`, next to the files bucket `llll-<uuid>-files`. The Server then writes a backup there:

- **every week**, from its weekly cron trigger;
- **before every update**, verified before the new release is uploaded. See [Updates](updates.md).

Archives are stored under `servers/<uuid>/` in the bucket, named by the time they were made. L4 does not delete old archives. Prune them yourself in the Cloudflare dashboard when you no longer need them, and keep at least one recent one.

In **Server settings → Deployment → Backups**, this bucket appears as **Separate backup bucket provided by this deployment**.

A Server with basic file storage has no backups bucket and makes no automatic backups. Download backups yourself, or connect R2 in **Server settings → Storage**.

## What a backup contains

Each backup is a TAR archive with:

- a logical export of the D1 database: Accounts, Members, Roles, messages, settings and the rest of the Server's data;
- every stored file, from R2 or from basic KV storage.

It does **not** contain:

- Worker environment secrets, including `AUTH_SECRET`;
- live Durable Object state;
- KV connection tickets;
- data held by external Providers, such as RealtimeKit.

> [!IMPORTANT]
> Settings saved on the Server, such as provider keys and kept Cloudflare access, are encrypted with `AUTH_SECRET`, which is not in the archive. The installer generates it as a secret on the Server's Worker, and Cloudflare does not display secret values. Data restored without the original secret cannot decrypt those settings; they must be entered again.

## Download a backup

1. Open **Server settings → Deployment → Backups**.
2. Under **Download to this device**, select **Download backup**.

The Worker reads the database and every stored file while the download runs. This can take a long time. Keep the tab open, and keep the Server idle until the download finishes.

## Save a backup to another bucket

You can also send backups to any S3-compatible service: Cloudflare R2, AWS S3, Backblaze B2, Wasabi, MinIO and others.

1. Open **Server settings → Deployment → Backups**.
2. Under **Save to S3-compatible bucket**, enter the **Endpoint**, **Region** (use `auto` for Cloudflare R2), **Bucket**, optional **Prefix**, **Access Key ID** and **Secret Access Key**.
3. Select **Test connection**, then **Save credentials**.
4. Select **Backup to bucket**. Keep the tab open; large Servers can take several minutes.

![The Backups settings with Download to this device and Save to S3-compatible bucket sections, the Endpoint, Region, Bucket, Prefix and key fields, and the Backup to bucket button](screenshot:cloudflare-backups "Server settings → Deployment → Backups")

> [!WARNING]
> Use a separate private bucket. Do not use the R2 bucket already bound to L4 for live files. Otherwise later archives can include earlier backups, and one bucket failure can remove both the files and their backups.

A bucket chosen here is for manual backups. It does not replace the backups bucket used by updates.

## Backups and removal

Backups are never deleted with a Server. When you [remove a Server](remove-a-server.md), keep its backups bucket and any downloaded archives until you are sure you no longer need them.

## Restoring

Restore means bringing the Server's data back into new, isolated resources and checking that the same UUID, Accounts, Roles, messages and files are there. There is no restore button in Settings, and updates never roll data back automatically. If you might need to recover a Server, keep its archives and do not delete its original Worker, which holds `AUTH_SECRET`. See [Files and backups](../concepts/files-and-backups.md).
