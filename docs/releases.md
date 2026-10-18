# Releases and deployments

L4 has one long-lived branch, `main`. Every same-repository PR gets an isolated Cloudflare Worker Preview. Ordinary merges accumulate in main without changing production or publishing a release. There is no production branch.

One shared version covers **llll** (Landing, Shell and installer), **Server**, **Instance** and **Docs**. The first release is `0.1.0-alpha.1` for fresh databases; the archived prototype is not an upgrade target. Existing customer Instances and Servers remain under their operators' update control.

## Validate a change

Open a focused PR to main. Required checks include lint, type checking, tests, migrations, builds, Instance/Server integration, self-host smoke and the deployed Cloudflare Preview. `release-policy` rejects a version change outside a release PR. See [isolated verification](worker-previews.md).

## Release PR

1. Create a branch from current main. Increase `version` in both `package.json` and `packages/deployment-core/package.json`, and add `docs/release-notes/v<version>.md` covering the accumulated changes.
2. Open the PR to main and apply the **release** label. It receives the same CI and native Worker Preview as other PRs. The version must increase, both package versions must match, and release notes must exist. A release label without a version change is rejected.
3. Merge after reviewing the Preview and required checks. The **Release** workflow validates the merged PR and waits for successful main CI at that exact merge commit. It builds all components from that commit, verifies module and asset hashes and migration chains, and includes the portable `linux/amd64` runtime image and Docs archive.
4. The workflow creates the version tag and an unpublished draft, verifies downloaded checksums, then publishes the complete immutable release. Alpha/beta/rc versions are prereleases. Only then does it trigger Cloudflare Workers Builds to deploy the released web archive and verify its commit and version at `https://llll.gg/api/health`.

Cloudflare's main build resolves published releases instead of building unreleased application code. Without a strictly newer published version, it exits before migrations or deployment. It verifies the release manifest, tag ancestry, version bump and archive checksums. Even if main advances while a release builds, production uses the artifact of the released tag. Docs links are pinned to that tag; Preview Docs links are pinned to their commit.

## Retry a failed release

Use **Release → Run workflow**, enter the already merged release PR number and leave `dry_run` enabled to validate without publishing or deploying. Disable dry run only to retry that exact release. An unpublished draft can be completed; a published tag and assets are never replaced. A production failure after publication retries deployment of the same immutable artifact. A newer deployed version is never rolled back by this runner. Fix code through another PR and version if the published artifact is wrong.

Cloudflare holds its build token and production secret. GitHub holds only `CLOUDFLARE_RELEASE_HOOK`, a secret capability for starting the configured main Build; it is not a Cloudflare account API token. Administrative configuration and cleanup use the connected Cloudflare API. Developer machines never deploy application code. iOS/macOS publication is frozen.

See [deployment artifacts](installer-releases.md) for the release contract. Customers explicitly select named prereleases; automatic runtime update discovery remains stable-only.

## Roll out an Instance

A release updates llll.gg and makes matching Instance/Server artifacts available. It does not force an update of customer installations. Back up Instance D1 and encryption/deployment secrets, and each Server to a separate backup destination. Operators apply matching modules/assets and pending migrations while preserving resource bindings, secrets and DO namespaces, then verify owner login, directory, local roles, files and realtime.
