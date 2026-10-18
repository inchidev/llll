# Releases and deployments

L4 uses one repository and immutable version tags. The first release is `0.1.0-alpha.1` for fresh databases; the archived prototype is not an upgrade target. `main` may be ahead of the latest published version. Site, common client, installation and server are independent artifacts; changing the landing does not require redeploying every Instance.

## Validate a change

Use a focused same-repository PR to `main`. Run lint, type checking, unit tests, migration checks, build, the installation integration fixture and isolated deployment verification described in [worker-previews.md](worker-previews.md). Record what was verified locally and in the isolated deployment. Production rollout is separate.

## Publish

1. Merge the validated change. Set the root and deployment-library version together and add `docs/release-notes/v<version>.md` before tagging.
2. Run the Tag release workflow on `main` after CI succeeds for that exact commit. It creates `v<version>` and dispatches both publishers. The image publisher adds its portable archive to the same unpublished draft. Never move or recreate a tag.
3. Wait for the installer-release and self-host image workflows. The installer workflow creates a draft GitHub Release.
4. Download the draft artifacts and verify `SHA256SUMS`, full module/asset integrity, version, and both ordered migration arrays. Check the portable Docker archive is included in `SHA256SUMS`, and verify its embedded image tag and architecture. It is delivered through the public release and requires no registry account.
5. Publish the verified draft, marking alpha/beta/rc versions as prereleases. Independently fetch its public manifest and checksums. Published artifacts are immutable; a repair needs a new version or an exact-tag recovery workflow only while the draft is unpublished. The installer offers complete named prereleases for explicit selection; automatic update discovery remains stable-only.

See [installer-releases.md](installer-releases.md) for the artifact contract. The site/common client are optional shared entry points; customer installations remain their own account and storage authorities.

## Roll out an installation

Back up control D1 and encryption/deployment secrets. Back up each server to a separate destination. Deploy matching modules and assets, apply only pending migrations, preserve existing resource bindings and verify owner login, directory, local server roles, files and realtime. The installation's configured Cloudflare token can update its servers; VPS deployments update through the operator's Compose configuration.

PWA updates wait for the visible update action; API/authentication/server requests are never cached by the service worker. iOS/macOS distribution is frozen. Real Safari/Telegram-device acceptance must be reported separately from browser emulation.
