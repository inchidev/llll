# Update a Server from Settings

A Cloudflare Server can be updated from **Settings → Deployment → Updates** without Git, GitHub or Workers Builds. The Owner chooses a newer published release and selects **Back up and update**. Stable releases are shown by default; **Include prereleases** explicitly includes named alpha/beta/rc releases. Only releases newer than the running version are selectable, so moving from a named alpha to a newer stable release is supported.

## The request stays local

1. The Server authenticates its own Owner, then validates the selected published release against GitHub Releases.
2. It saves one private request in the Server's `server_update_control` D1 table and returns a launch URL for the official installer at `https://llll.gg/create?tab=cloudflare&server=…&account=…&worker=…&update=…`. The URL contains no credential.
3. The Server also creates a one-job backup capability (`backupToken`). It is never returned by Settings APIs. The capability can create that request's pre-update backup once and cannot read account resources or upload code.
4. An atomic SQL revision check prevents two owner requests, a browser update and a Build from claiming the same operation.

No Cloudflare account API token is stored on the Server. The account is billed directly for resources the update uses.

## Browser update

The official installer performs the update in phases. Each phase is a separate browser request, so reloading or closing the page does not lose the saved operation; reopen the launch URL from Settings to continue.

1. **Fresh consent.** The installer asks the Owner for Cloudflare OAuth consent at update time. The grant is encrypted inside the bounded, browser-bound installer session. The Server receives only its one-job backup capability.
2. **Release verification.** The installer reads the release's `SHA256SUMS`, verifies the Cloudflare manifest hash and `llll-server-schema-v1` capability, and lets `updateL4` verify every module and asset hash again before upload.
3. **Verified backup.** The installer claims the saved request with its own executor ID and calls the Server's backup endpoint. The Server streams its logical D1 export and live files to the deployment's separate `BACKUPS` bucket. The installer then reads the **persisted** object from R2 and checks:
   - the archive's SHA-256 and the total byte count against the receipt;
   - every tar header, entry size and checksum, with bounded memory;
   - the archive's `summary.json` and its table, row, R2-object and byte counts;
   - every R2 metadata record against its matching payload and size;
   - the live D1 table count and total row count, and the live files-bucket object and byte inventory.

   If the live inventory changed while the backup was made, the update stops **before** deployment and asks the Owner to retry with low Server activity. This is an inventory-level check, not an atomic cross-service snapshot. Unlike the legacy Build path, a Worker cannot restore the whole SQLite file on disk, so the site path does not repeat a SQLite restore and foreign-key check.
4. **Direct upload.** Only after verification does the installer call the same published-release updater used by installation. It applies the release's ordered migrations and uploads its checksum-verified modules and assets. Existing bindings, encryption secrets, UUID and Durable Object namespaces are preserved. Unreleased or locally built code is never accepted; a published tag and its assets are immutable.
5. **Verification and completion.** The installer checks the same Server UUID at any of the Server's listed addresses (primary or alias), the selected version in `/.well-known/llll`, and a ready, migrated `/api/setup/health`. It then records completion and clears the one-job backup capability. Settings shows the backup receipt and progress. When a new Client is waiting, use **Update Client** or its update banner.

The backup preserves the update control table schema and encrypted hook, but clears its operation, capability and busy flag, so restoring a backup cannot revive an active update. Environment secrets, ephemeral Durable Object state, KV tickets and external provider data are not in the archive. Preserve the original encryption/provider secrets separately. Backups remain in their separate bucket after an update, cancellation or later Server removal.

## Legacy Build path

A Server with a Git-connected Workers Build may still connect a deploy hook. This is optional and only needed for an existing Build-installed Server; it is not a prerequisite for updates.

- The hook is supplied by the operator as `LLLL_UPDATE_HOOK` or saved encrypted in Settings. It can start only that Worker's branch Build and cannot read account resources or upload code.
- The Build reads the saved request with its deployment token. It downloads the persisted backup, checks SHA-256, restores SQLite on disk, verifies the UUID, schema, foreign keys and file payloads, then applies the release and verifies health. This path retains the stronger restore verification because it runs outside the Worker.
- The Build path is still shown in Settings when a hook is configured. A timeout starting a hook keeps the same request locked because a Build may already have started; it never silently creates a second operation.

## Retry and recovery

- A queued request can be continued from Settings, or cancelled before execution. A request whose backup failed before deployment can be retried; an unverified archive is discarded and a fresh backup is made.
- If a browser session is lost, reopen the launch URL. A different browser may take over an active site update only after its last stage transition is more than 20 minutes old and no backup is still being written.
- A failure after deployment begins stays in **Deployment needs verification** and blocks different updates. Reopening the launch URL rechecks identity and health, and reruns the idempotent upload only when the target version is not already installed.
- Temporary Cloudflare upload responses (HTTP 408, 429, 500, 502, 503 and 504) are retried with bounded backoff and a fresh inspection of the Worker. The verified backup and prepared assets are not repeated by that loop.
- There is no automatic downgrade or destructive data rollback. The verified backup remains available in the separate bucket for operator recovery.

## Other runtimes

VPS/celld updates remain operator-managed with `llll upgrade` and its mandatory full-volume backup/rollback. A Server without a live-files binding and a separate `BACKUPS` destination does not offer browser updates. An S3 destination selected for manual backups does not replace the operator-owned `BACKUPS` binding used by Cloudflare updates.

`LLLL_UPDATE_SITE` optionally overrides the official installer origin; it defaults to `https://llll.gg`. The Server's `PUBLIC_ORIGIN` and every `server_domains` alias are HTTPS origins; the update launch starts at the address the owner used and probes the others if it is unreachable.
