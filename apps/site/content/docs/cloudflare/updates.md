---
title: Update a Cloudflare Server
description: Update your Cloudflare L4 Server to a newer published release from its Settings, with a verified backup first, with or without the installer.
order: 6
---

A Cloudflare Server updates only when its Owner chooses to. Every update installs a published, checksum-verified release and makes a verified backup first. You never need Git, GitHub or Workers Builds.

There are two ways an update runs:

- **On the Server itself**, when the Server keeps Cloudflare access. You can close the page while it runs.
- **Through the official installer** on llll.gg, with a fresh Cloudflare authorization for that one update.

## Start an update

1. In your Server, open **Server settings → Deployment → Updates**. The Deployment entry shows a badge when newer releases exist.
2. Check **Installed version**.
3. Choose a **Release**. Only published releases newer than the installed version can be selected. Check **Include prereleases** to also list alpha, beta and rc releases.
4. Read the release notes shown below the selector.
5. Select **Back up and update**.

![The Updates settings with the Cloudflare access card, the Installed version, the Release selector with release notes, and the Back up and update button](screenshot:cloudflare-updates "Server settings → Deployment → Updates")

What happens next depends on whether the Server keeps Cloudflare access.

## When the Server keeps Cloudflare access

The request is saved on the Server. Select **Start update**. The Server then:

1. verifies the release against its published checksums;
2. writes a backup to its separate backups bucket and reads it back to check its size and SHA-256;
3. uploads the release;
4. lets the new version confirm its own version and migrations.

You can close the page. Each stage is recorded before it starts. A failure before the upload stops with nothing changed. A failure after it asks for attention; select **Retry update** to resume after the verified backup.

This path needs the separate backups bucket. A Server with basic file storage uses the installer path with a downloaded backup.

## Through the official installer

The request is saved on the Server. Select **Continue on llll.gg**. The installer opens a page titled **Update a Server**.

1. Connect Cloudflare and approve the permissions. The grant stays in your browser's installer session.
2. Optional: leave **Keep Cloudflare access on this Server** checked so later updates run from Settings.
3. Select **Back up and update**.

The installer shows each phase: **Verify the published release**, **Back up and verify Server data**, **Upload the new release**, **Wait for Cloudflare verification** and **Update complete**. Each phase is saved, so reloading or closing the page loses nothing. Reopen the update from Settings to continue.

The installer's backup check is thorough. It reads the stored archive back from R2 and compares its hash, size, every entry and the database and file inventories with the live Server. If the Server changed while the backup was made, the update stops before deployment and asks you to retry with low activity.

When it finishes, select **Open your Server**.

### Without a backups bucket

If the Server uses basic file storage and has no separate backups bucket, Settings shows **Download backup** first. Your browser downloads the complete archive and checks it before the update may continue. Keep that file for recovery.

## After the update

If your browser still shows the old interface, Settings offers a button to load the new one. The Server's UUID, Accounts, bindings, secrets and storage are kept.

## If something goes wrong

- **Cancel request** removes a queued update before it starts.
- If the backup failed before deployment, retry; an unverified archive is discarded and a new backup is made.
- If the browser session was lost, reopen the update from Settings. A different browser can take over an active update only after its last step is more than 20 minutes old and no backup is still being written.
- A failure after deployment began shows **Deployment needs verification**. Reopening the update rechecks the Server and reruns the upload only if the new version is not installed yet.

There is no automatic downgrade or data rollback. The verified backup stays in the separate bucket for recovery. See [Backups](backups.md).

## Release lineage

A Server updates only within its schema lineage. Servers on 0.3.x use `server-v2`. A 0.2.x Server cannot be updated to 0.3.0 or later; install a new Server instead. See [Releases and updates](../concepts/releases-and-updates.md).
