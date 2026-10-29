---
title: A backup is not a second running Server
description: What an independent workspace needs to recover, and why its backup destination is separate from live files.
date: 2026-10-21
author: Inchi
---

A Server can work perfectly today and still need a recovery plan for tomorrow. A backup is a copy used for recovery. It is not a live replica and it should not be confused with the bucket holding the files people use every day.

## What needs to survive?

A useful recovery plan covers more than chat messages. Server identity, Accounts, configuration, secrets and content belong together. Restoring content without the identity or the secrets it depends on may leave a workspace that looks familiar but cannot operate as the same Server.

L4 gives each Server a persistent UUID. The recovery objective is to bring back the Server and its data with that identity intact, then check that Members and their permissions still behave as expected.

## Keep the copy separate

On Cloudflare with R2, the installer creates a backups bucket next to the live files bucket, and the Server writes a backup there every week and before every update. Without that bucket, you download the backup from Settings or send it to an S3 bucket of your own. Removing a Server never deletes backups. On a VPS, `llll backup` archives the whole installation. The details are in [Files and backups](/docs/concepts/files-and-backups). Separation reduces the chance that an operation on live resources also destroys the recovery copy; it does not by itself prove that a backup can be restored.

## Practice recovery

Before calling a backup plan complete, make a copy, restore it into an isolated environment and check the result: identity, owner sign-in, a second Member, permissions, a message and a file. Record which release and deployment target were used. Protect the recovery material and secrets with the same care as the live workspace.

We are still testing restores on real Cloudflare and VPS Servers, and we'll report those results separately from automated tests. A backup's value is not that a button said it succeeded; it is that you can recover the community when you need it.
