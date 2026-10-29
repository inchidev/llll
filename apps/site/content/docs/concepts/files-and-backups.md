---
title: Files and backups
description: Where an L4 Server stores messages and files, what a Backup contains and leaves out, and why backups live apart from live storage.
order: 4
---

A Server keeps its data in its own storage. A Backup is a recovery copy kept somewhere else. It is not a second running Server.

## Where data lives

| Data | On Cloudflare | On a VPS (celld) |
| --- | --- | --- |
| Messages, Accounts, Roles, Tasks, Mail records, settings | The Server's D1 database | celld's D1, stored in the private RustFS bucket |
| Files and attachments, raw email | The Server's private R2 files bucket, or Basic KV storage | The same RustFS bucket |
| Live state (presence, typing, active calls) | Durable Objects | celld Durable Objects |
| Backups | A separate backups bucket, or a download | Archives outside the live volumes |

Every file read goes through the Server's normal authorization. Files are never served from a public bucket.

### Basic KV storage on Cloudflare

A Cloudflare Server can run without R2. File payloads are then stored in the Server's existing KV namespace, with a limit of 20 MiB per file and 500 MiB in total. Cloudflare's own KV limits and daily quotas still apply.

To move to R2, open **Server settings → Storage**, choose **Connect R2**, then **Move files to R2**. The copy runs in resumable batches and checks every file's hash. Uploads pause while it runs; reading continues. The original KV copies are kept.

If a Server has no file storage at all, uploads and full backups fail with "File storage is unavailable. Ask the Server operator to configure storage."

## What a Backup contains

The Server's own backup (**Server settings → Deployment → Backups**) is a TAR archive with:

- A logical export of the D1 database: messages, authentication records, Roles and all other Server data.
- The live files (R2 objects, or KV file payloads on Basic storage).
- A summary of table, row, object and byte counts.

It does **not** contain:

- Environment secrets, including `AUTH_SECRET`.
- Live Durable Object state.
- KV connection tickets.
- Data held by external providers, such as RealtimeKit.

> [!IMPORTANT]
> Keep the original `AUTH_SECRET` (and any provider secrets) safe and separate from the archive. Stored credentials, such as model provider keys, backup keys and the Server's push notification identity, are encrypted with it. A restore with a different secret cannot decrypt them.

## Where Backups go

On Cloudflare, the installer creates a separate backups bucket next to the files bucket. If it exists, the Server writes a backup there every week, and before every update. Without one, Settings downloads the archive to your computer. You can also save S3 credentials for a separate destination of your own; use a private bucket that is not the files bucket L4 already uses.

On a VPS, `llll backup` archives the whole installation, including `.env` and all volumes. On Docker Compose or Coolify you stop the stack and archive the volumes yourself. See [VPS](../self-host/vps.md#backups) and [Docker Compose](../self-host/docker.md#back-up-and-restore).

![Server settings → Deployment → Backups with the Download backup button and the archive scope note](screenshot:concepts-backups-settings "Backups in Deployment settings")

## Backups stay separate

- Backups are never stored in the live files bucket. Otherwise later archives could include earlier ones, and one bucket failure could remove both the files and their backups.
- Removing a Server never deletes its backup bucket or backup archives.
- Restoring a backup brings back the same Server UUID, Accounts, Roles, messages and files.

Updates make a verified backup first. See [Releases and updates](releases-and-updates.md).

## Related

- [Backups on Cloudflare](../cloudflare/backups.md)
- [Remove a Server](../cloudflare/remove-a-server.md)
