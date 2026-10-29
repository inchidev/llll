---
title: How an L4 Server gets installed on Cloudflare
description: A look at the published release, resources and owner setup behind the Cloudflare installer.
date: 2026-10-29
author: Inchi
---

Installing a workspace should not require an operator to connect a source repository or build the app on their laptop. L4's Cloudflare installer is designed around a published Server release and the owner's own Cloudflare account.

## From release to Server

In the Cloudflare tab of `/create`, an operator selects an account, names the Server and chooses a published release. The installer uses an authorized Cloudflare connection to create the Server's resources. It checks the release checksums before allocating them; a missing or mismatched checksum stops the install.

A Server gets its own Worker, database, key-value storage and Durable Objects. If R2 is enabled on the account, private files and backups get two separate buckets. Without R2, files are stored in key-value storage instead, and you download backups from Settings or send them to an S3 bucket of your own. The resources belong to the operator's account, so Cloudflare's own limits and charges still apply.

The installer generates a Server UUID and uses it across resource names and Server identity. The owner then completes setup on the Server's own origin and creates the local owner Account. That Account belongs to this Server, not to a shared L4 identity service.

## What about updates?

The owner can let the Server keep Cloudflare access, encrypted with its Server secret. That box is checked by default during installation. A Server that keeps access updates itself from **Server settings → Deployment → Updates**, without going back to llll.gg. A Server without it updates through the llll.gg installer with a fresh Cloudflare authorization for that one update ([Updates](/docs/cloudflare/updates)).

Either way, an update installs a published, checksum-verified release and makes a verified backup first. You never need Git, GitHub or Workers Builds. Backups still deserve their own restore test before you rely on them.

## Verify the whole journey

An install is more than a successfully created Worker. Claim the owner Account, invite a second person, exchange a message and a file, reload and reconnect. Try the direct Server address and the Shell. Provider and browser behavior can differ, so record the environment and result rather than assuming one successful step proves the whole journey.
