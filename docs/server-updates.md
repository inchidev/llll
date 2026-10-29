# Update a Server from Settings

A Cloudflare Server can be updated from **Settings → Deployment → Updates** without Git, GitHub or Workers Builds. The Owner chooses a newer published release and selects **Back up and update**. Stable releases are shown by default; **Include prereleases** explicitly includes named alpha/beta/rc releases. Only releases newer than the running version are selectable, so moving from a named alpha to a newer stable release is supported.

## The request stays local

1. The Server authenticates its own Owner, then validates the selected published release against GitHub Releases.
2. It saves one private request in the Server's `server_update_control` D1 table and returns a launch URL for the official installer at `https://llll.gg/create?tab=cloudflare&server=…&account=…&worker=…&update=…`. The URL contains no credential.
3. The Server also creates a one-job backup capability (`backupToken`). It is never returned by Settings APIs. The capability can create that request's pre-update backup once and cannot read account resources or upload code.
4. An atomic SQL revision check prevents two owner requests, a browser update and a Build from claiming the same operation.

Unless the Owner keeps Cloudflare access on the Server (below), no Cloudflare credential is stored there. The account is billed directly for resources the update uses.

## Update from the Server

A Server can keep Cloudflare access and update itself, with no installer and no open tab. The installer offers **Keep Cloudflare access on this Server**, on by default, when it installs or updates a Server; Settings → Deployment → Updates can instead take an API token created from a pre-filled Cloudflare link (Workers Scripts, D1, R2, KV edit and Account Settings read). For safety, run each Server in its own Cloudflare account; a free account is enough. This is a recommendation, not a requirement.

- **Handoff.** After the Server runs, the installer writes a single-use capability hash into the Server's D1, posts its OAuth grant to `/api/cloudflare-account/handoff`, and forgets the grant, so only the Server refreshes it. The Server checks that the grant reaches its own account and stores it encrypted with `AUTH_SECRET`. A failed handoff never fails an install or update.
- **Use.** Only the Owner can connect or disconnect it. Settings show its kind, account and date, never the credential. Refreshed, rotated grants are written conditionally so a stale refresh cannot replace a newer one. Disconnecting deletes it from the Server; an OAuth grant also stays revocable in Cloudflare.
- **Update.** **Back up and update** then runs in a Durable Object alarm: verify the published release against `SHA256SUMS`, write the backup to the separate `BACKUPS` bucket and read it back to check its size and SHA-256, upload the release with the same updater the installer uses, and let the new version confirm its own version and migrations. Each stage is recorded before it starts. A failure before the upload stops with nothing changed; a failure after it asks for attention, and **Retry update** resumes after the verified backup. Without a `BACKUPS` bucket the installer path with a downloaded backup remains.
- **Other changes.** The same access attaches, promotes and removes Server addresses, connects mail domains (Email Routing, Email Sending and the Worker binding) and connects Live without a separate RealtimeKit token; Live stores a marker and resolves the current token on each call. Moving files from Basic KV storage to R2 and provisioning a compute node still go through the official installer.
- **Renewal.** The weekly cron renews a kept OAuth grant before its backup, so a Server that changes nothing for months still holds a live grant. A failed renewal does not skip the backup; Settings asks to reconnect when access stops working.
- **Known limits.** The upload runs in one alarm invocation; on the Workers Free plan its subrequest budget is tight for large asset changes. The backup check here compares the stored archive with what was written; the installer path also compares table and object inventories.

## Browser update

The official installer performs the update in phases. Each phase is a separate browser request, so reloading or closing the page does not lose the saved operation; reopen the launch URL from Settings to continue.

1. **Fresh consent.** The installer asks the Owner for Cloudflare OAuth consent at update time. The grant is encrypted inside the bounded, browser-bound installer session. The Server receives only its one-job backup capability.
2. **Release verification.** The installer reads the release's `SHA256SUMS`, verifies the Cloudflare manifest hash and `llll-server-schema-v2` capability, and lets `updateL4` verify every module and asset hash again before upload.
3. **Verified backup.** The installer claims the saved request with its own executor ID and calls the Server's backup endpoint. The Server streams its logical D1 export and live files to the deployment's separate `BACKUPS` bucket. The installer then reads the **persisted** object from R2 and checks:
   - the archive's SHA-256 and the total byte count against the receipt;
   - every tar header, entry size and checksum, with bounded memory;
   - the archive's `summary.json` and its table, row, R2-object and byte counts;
   - every R2 metadata record against its matching payload and size;
   - the live D1 table count and total row count, and the live files-bucket object and byte inventory.

   If the live inventory changed while the backup was made, the update stops **before** deployment and asks the Owner to retry with low Server activity. This is an inventory-level check, not an atomic cross-service snapshot. A Worker cannot restore the whole SQLite file on disk, so the site path does not repeat a SQLite restore and foreign-key check.
   Without a separate BACKUPS bucket, Settings downloads the complete archive to the owner’s computer first. The browser hashes the completed download and acknowledges the Server-recorded digest and byte count. An interrupted or mismatched download cannot authorize deployment. The installer accepts only that verified receipt for the same queued request. Keep the downloaded archive for recovery.
4. **Direct upload.** Only after verification does the installer call the same published-release updater used by installation. It applies the release's ordered migrations and uploads its checksum-verified modules and assets. The pre-upload schema additions preserve the old conversation types. The group-DM conversion runs idempotently in the new Worker's initialization, after its code is active, so a failed code upload leaves the previous Worker's groups intact. Existing bindings, encryption secrets, UUID and Durable Object namespaces are preserved. Unreleased or locally built code is never accepted; a published tag and its assets are immutable.
5. **Verification and completion.** The installer checks the same Server UUID at any of the Server's listed addresses (primary or alias), the selected version in `/.well-known/llll`, and a ready, migrated `/api/setup/health`. It then records completion and clears the one-job backup capability. Settings shows the backup receipt and progress. When a new Client is waiting, use **Update Client** or its update banner.

The backup preserves the update control table schema, but clears its operation, capability and busy flag, so restoring a backup cannot revive an active update. Environment secrets, ephemeral Durable Object state, KV tickets and external provider data are not in the archive. Preserve the original encryption/provider secrets separately. Backups remain in their separate bucket after an update, cancellation or later Server removal.

## Git-connected Build path (legacy)

The deploy hook has been removed. A queued request is always continued on the official installer, which performs the verified upload with a fresh one-time OAuth grant; the Server never starts an upload itself.
## Retry and recovery

- A queued request can be continued from Settings, or cancelled before execution. A request whose backup failed before deployment can be retried; an unverified archive is discarded and a fresh backup is made.
- If a browser session is lost, reopen the launch URL. A different browser may take over an active site update only after its last stage transition is more than 20 minutes old and no backup is still being written.
- A failure after deployment begins stays in **Deployment needs verification** and blocks different updates. Reopening the launch URL rechecks identity and health, and reruns the idempotent upload only when the target version is not already installed.
- Temporary Cloudflare upload responses (HTTP 408, 429, 500, 502, 503 and 504) are retried with bounded backoff and a fresh inspection of the Worker. The verified backup and prepared assets are not repeated by that loop.
- There is no automatic downgrade or destructive data rollback. The verified backup remains available in the separate bucket for operator recovery.

## Other runtimes

VPS/celld updates remain operator-managed with `llll upgrade` and its mandatory full-volume backup/rollback. A Cloudflare Server with basic KV file storage can use browser updates with a verified downloaded backup. An S3 destination selected for manual backups does not replace the operator-owned `BACKUPS` binding used by Cloudflare updates.

`UPDATE_SITE` optionally overrides the official installer origin; it defaults to `https://llll.gg`. The Server's `PUBLIC_ORIGIN` and every `server_domains` alias are HTTPS origins; the update launch starts at the address the owner used and probes the others if it is unreachable.
