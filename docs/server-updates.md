# Update a Server from Settings

For a Git-connected Cloudflare Server, its local Owner can choose a published release under **Settings → Deployment → Updates** and select **Back up and update**. Stable releases are shown by default; **Include prereleases** explicitly includes named alpha/beta/rc releases. Only releases newer than the running version are selectable. This also supports moving from a named alpha to a newer stable release.

## Connect the Build once

New Servers created by the official Cloudflare installer receive a dedicated **L4 Server updates** deploy hook automatically. The installer stores it as a private Build variable; the Git-connected Build supplies `LLLL_UPDATE_HOOK` to that Server. No Cloudflare account API token is stored by the update feature on the Server.

For an existing Server, first adopt a release containing this feature through the operator's verified backup/update procedure. Its Git-connected repository must include the matching `scripts/server-deploy.mjs` and `scripts/server-update.mjs`. Create a deploy hook for that Worker and repository branch in Cloudflare Workers Builds, then paste the hook URL or ID into Updates. The Owner can replace a hook saved in Settings; a hook supplied by an environment secret is rotated by the operator instead.

The runtime accepts only Cloudflare's canonical deploy-hook endpoint or a UUID. A saved hook is encrypted with the Server's original `AUTH_SECRET`; it is never returned through the settings APIs. Hook access can start that Worker's branch Build but cannot read account resources or upload application code. Keep both the hook and `AUTH_SECRET` private.

## What an update does

1. The Server authenticates its own Owner and validates the selected published release. It saves one private request in the Server’s `server_update_control` D1 table, then calls its narrow Build hook. An atomic SQL revision check prevents two owner requests or Builds from claiming the same operation. The feature appends migration `0001_server_updates.sql`; the published baseline is unchanged.
2. The Git-connected Build reads that request using its existing deployment token. It verifies the release provenance, immutable tag commit, runtime manifest and module/asset hashes before deployment.
3. The Build gives the running Server a single-job backup capability. The Server streams its logical D1 export and live files to the separate backup bucket with bounded multipart buffers. The Build downloads the **persisted** archive to a private temporary file, checks its SHA-256, restores SQLite on disk, verifies UUID/schema/foreign keys and file payloads, and compares every community table and the file inventory with the running Server. A failed or changing backup stops the operation **before** deployment. Keep Server activity low while the backup runs. This optimistic check is not an atomic cross-service snapshot.
4. Only after successful backup verification does the Build apply the selected release's ordered migrations and deploy its verified artifact. Existing bindings, encryption secrets and Durable Object namespaces are inherited. The runtime never uploads code itself.
5. The Build checks the same Server UUID, public name/icon, ready status and selected version, then records completion. The settings page shows progress and the backup receipt. It is safe to close the page and return; the operation is stored independently of the browser and Worker code. When a new Client is waiting, use **Update Client** or its update banner.

The backup preserves the update control table schema and encrypted hook, but clears its operation, one-job capability and busy flag. Restoring a backup cannot revive an active update. This normalized control row is excluded from live-data comparisons.

Backup scope remains the logical D1 database and live files. Environment secrets, ephemeral Durable Object state, KV tickets and external provider data are not in that archive. Preserve the original encryption/provider secrets separately. Backups remain in their separate bucket after an update, cancellation or later Server removal.

## Retry and recovery

A queued request can be started again or cancelled. If Cloudflare reused a Build already in flight, use **Start Build again** after it finishes. A timeout starting a hook keeps the same request locked because a Build may already have started; it never silently creates a second operation.

A backup/release check that fails before deployment is retryable with a new request. An error after deployment begins stays in **Deployment needs verification**, blocking different updates. Use its Build log to inspect the result, then **Resume stopped Build**. The same recovery is offered for a stale operation after a Build was cancelled or killed. A replacement Build must confirm the preceding Build is stopped before claiming it; recovery requires Workers CI Read on the Build token. If the selected version is already installed, it verifies completion without deploying it again. Otherwise it repeats backup verification before retrying. There is no automatic downgrade or destructive data rollback.

Ordinary repository Builds no longer change an already claimed Server merely because the bootstrap `LLLL_SERVER_RELEASE` variable differs. They process an explicit saved Owner request or leave the installed Server unchanged. The bootstrap variable still selects the release for a new Server.

## Other runtimes

VPS/celld updates remain operator-managed with `llll upgrade` and its mandatory full-volume backup/rollback. A local or custom Server without a Git-connected Cloudflare Build, live-files binding and separate `BACKUPS` destination shows that requirement instead of offering a nonfunctional update button. An S3 destination selected for manual backups does not replace the operator-owned `BACKUPS` binding used by Cloudflare updates.
