# Releases and deployments

L4 has one long-lived branch, `main`. Every same-repository PR gets an isolated Server Preview. Ordinary merges accumulate in main without publishing a release. There is no production branch.

One shared version covers **Server** and **Docs**. A release publishes immutable artifacts and nothing else; the website, installer and llll.gg ship from a private repository, which consumes them. The first release is `0.1.0-alpha.1` for fresh databases; the archived prototype is not an upgrade target. Customer Servers remain under their operators' update control.

## Validate a change

Open a focused PR to main. Required checks include lint, type checking, tests, migrations, builds, Server integration, self-host smoke and the deployed Cloudflare Preview. `release-policy` rejects a version change outside a release PR. See [isolated verification](worker-previews.md).

## Release PR

1. Create a branch from current main. Increase `version` in both `package.json` and `packages/deployment-core/package.json`, add `docs/release-notes/v<version>.md` covering the accumulated changes, and add `"<version>": "<YYYY-MM-DD>"` to `content/release-dates.json` so the release appears at llll.gg/changelog.
2. Open the PR to main and apply the **release** label. It receives the same CI and native Worker Preview as other PRs. The version must increase, both package versions must match, and release notes must exist. A release label without a version change is rejected.
3. Merge after reviewing the Preview and required checks. The **Release** workflow validates the merged PR and waits for successful main CI at that exact merge commit. It builds all components from that commit, verifies module and asset hashes and migration chains, and includes the portable `linux/amd64` runtime image and Docs archive.
4. The workflow creates the version tag and an unpublished draft, verifies downloaded checksums, then publishes the complete immutable release. Alpha/beta/rc versions are prereleases. 


## Retry a failed release

Use **Release → Run workflow**, enter the already merged release PR number and leave `dry_run` enabled to validate without publishing. Disable dry run only to retry that exact release. An unpublished draft can be completed; a published tag and assets are never replaced. Fix code through another PR and version if the published artifact is wrong.

Administrative configuration and cleanup use the connected Cloudflare API. Developer machines never deploy application code. Native app publication is frozen.

See [deployment artifacts](installer-releases.md) for the release contract. Customers explicitly select named prereleases; automatic runtime update discovery remains stable-only.

## Roll out a Server

A release publishes standalone Server artifacts. Operators keep their selected Server version pinned. A local Owner can select a newer release in [Settings → Deployment → Updates](server-updates.md) on a Cloudflare Server; a verified pre-update backup is mandatory. The default path needs no Git, GitHub or Workers Builds: the official installer uploads the published, checksum-verified artifact through the Owner's fresh Cloudflare grant, and the Server keeps no account-wide credential. An existing Build-installed Server may still use its optional deploy hook. Managed VPS installations use the same release assets through the [VPS CLI](vps-installer.md#operations), with mandatory backup and data rollback on a failed upgrade. Back up its D1, live files and original encryption secrets to separate storage. Cloudflare updates preserve resource bindings, secrets, UUID and DO namespaces; VPS operators apply the verified portable image. Verify local owner/member login, permissions, files, realtime and the same UUID before considering the update complete.

The active Server schema is `server-v1`, beginning at `drizzle/server-migrations/0000_baseline.sql`. Create a fresh database; migrations append to this baseline.
