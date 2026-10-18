# Initial alpha validation

Baseline: `0.1.0-alpha.1`, prepared on 2026-10-18. The source and release history start fresh; prototype deployments are not upgrade targets.

## Local checks

- Frozen-lockfile dependency installation completed on Node 24.21.0 and pnpm 10.30.3.
- Lint, root types, site/web types and Instance types passed.
- 92 unit-test files passed, containing 494 tests. Historical upgrade-fixture tests were replaced by tests of the shipped fresh schemas.
- The migration checker found one contiguous `0000` migration for each of Server, Instance and web. Drizzle reported no schema changes against the initial snapshot.
- Server, Instance, site/Shell and installer artifacts built. The Server Worker passed a minified Wrangler bundle dry run.
- The isolated three-Worker fixture passed owner bootstrap, identity, invitations, cross-server HTTP/WebSocket denial, private files, session revocation and PKCE/OIDC flows. Server and Instance archives were restored into fresh SQLite databases with clean foreign-key checks and preserved message/owner data.
- The isolated web fixture passed assets, installer configuration, unavailable OAuth and cross-origin mutation denial.

## Cloudflare isolation

Account operations used the connected Cloudflare API tool. New test Workers, D1 databases, file buckets and KV namespaces were provisioned separately from the existing site and prototype. Live and Backup buckets are distinct. Operator-owned resource IDs, origins and credentials are in ignored `.deployment` state.

The network fixture in [test-initial-cloudflare.mjs](../scripts/test-initial-cloudflare.mjs) passed owner identity, two Servers, UUID routing, message isolation, private files, invitation-only admission, cross-server denial, actual WebSocket handshakes, rejection of a ticket at another Server, logout/session revocation, and separate Server/Instance backups. The fixture permits longer deadlines for remote archive generation than for ordinary API calls.

The published release has its own checksums and module/asset hashes. The isolation fixture validates the source build; release publication must separately verify the downloaded artifacts and public image before claiming those deliverables complete.

## Limits

Follow-up [browser acceptance](alpha-browser-acceptance.md) reproduced deployment, deep-link, socket-revocation and sign-out defects in the published alpha. That report separates the original release from unreleased fixes and the connector's fresh-installer limitations.

- This is a developer alpha, not a completed production rollout. Existing site and prototype deployments were not migrated to these baselines.
- No remote browser or static-asset acceptance is claimed. The isolated Cloudflare Workers exercise application HTTP/WebSocket APIs; the frontend and installer assets were checked by builds and local fixtures.
- VPS/celld transport and reload issues remain open. Local Docker was unavailable; the initial CI Linux Compose job passed startup, owner setup and two-Server isolation. The final release commit must pass CI again before publication. That check does not certify the unresolved browser flows.
- Email delivery, inference, media Providers, real-device push, Safari and Telegram-device behavior require independent acceptance.
- Restoring the local fixture's archives into SQLite proves schema/content recovery, not a complete operator disaster-recovery drill with production secrets and domains.
