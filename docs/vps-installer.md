# VPS installer

The installer runs the [common Compose](../self-host/docker-compose.yml): one standalone Server on celld, a private RustFS bucket and Caddy. `compose.vps.yml` exposes only Caddy's HTTP/HTTPS ports. The local development override uses the same services with source watching instead of a release image. Accounts, UUID, files and realtime remain local to this Server; mail, AI and other external providers are optional additions in its private `.env`.

This installer first ships in `0.2.0-alpha.7`. Earlier published releases, including `0.2.0-alpha.6`, do **not** contain it. Feature Previews intentionally return 404 for `/install.sh`; merging this feature does not publish it or change production. VPS/celld remains experimental until fresh-VM HTTPS and browser acceptance have been recorded.

## Requirements

Use a dedicated amd64 VPS with Debian 12/13 or Ubuntu 22.04/24.04, at least 2 GiB RAM and 5 GiB free disk. Point a domain's A/AAAA records at it and open inbound TCP 80/443 (UDP 443 is optional HTTP/3). `bash`, `curl`, CA certificates and the distribution's standard core utilities must be present. The script installs missing jq/OpenSSL/iproute2, then Docker Engine and Compose from Docker's official apt repository if Docker is absent. Existing Docker requires Engine >=24 and Compose >=2.24.4; it is never replaced automatically. Snap Docker and remote daemons are refused.

A domain is required. There is no automatic public-IP lookup, shared DNS zone or sslip.io fallback. Caddy provisions and renews public certificates; no Docker socket is mounted in Caddy or the Server. [Caddy's HTTPS requirements](https://caddyserver.com/docs/automatic-https) include correct DNS and reachable ports. A VPS with another proxy should use the [raw Compose](../self-host/README.md#reverse-proxy-and-tls) instead.

## Install after publication

For a prerelease, select that channel explicitly:

```sh
curl -fsSL https://llll.gg/install.sh | sudo env \
  LLLL_DOMAIN=chat.example.com \
  LLLL_ADMIN_EMAIL=owner@example.com \
  LLLL_CHANNEL=prerelease bash
```

Once stable releases exist, omit `LLLL_CHANNEL`. The downloaded script pins its exact version, Git commit, runtime SHA-256 and Compose hashes. It never builds source on the VPS. A checksum failure aborts before installing packages, loading an image or creating installation files/data. Temporary download files and a runtime lock are removed/closed on exit. SHA256SUMS and provenance are fetched over GitHub HTTPS; this is not a signed release system.

To inspect and verify a named release before running it:

```sh
version='<published-version>'
base="https://github.com/inchidev/llll/releases/download/v${version}"
curl -fSLO "$base/install.sh"
curl -fSLO "$base/SHA256SUMS"
awk '$2 == "install.sh"' SHA256SUMS | sha256sum --check
less install.sh
sudo env LLLL_DOMAIN=chat.example.com LLLL_ADMIN_EMAIL=owner@example.com \
  LLLL_CHANNEL=prerelease bash install.sh
```

The script runs only after its final `main` call is downloaded. `/install.sh` in the official web release is byte-for-byte the release asset, served as `text/plain`. Missing script/installer/JSON paths return 404 instead of the landing page.

Installation creates `/opt/llll` (0700), `.env` (0600), a private CLI copy and `/usr/local/bin/llll`. It waits for Compose health and verifies the public origin, version and UUID. Only an unclaimed Server prints `/setup#claim=…`; the claim is printed to the caller, with no installer log or claim file. Avoid capturing terminal output in shared logs. Claim the owner, invite a member, and verify files and realtime before inviting more people.

Rerunning the same installer restarts/verifies its managed Server without changing `.env`, credentials, volumes or UUID. Another version requires `llll upgrade`; an unrelated nonempty directory is refused. Installation failures retain private configuration for diagnosis. Fix DNS/firewall/configuration and rerun the same pinned script.

## Operations

```sh
sudo llll status
sudo llll logs
sudo llll stop
sudo llll start
sudo llll backup
sudo llll upgrade                       # latest stable only
sudo env LLLL_CHANNEL=prerelease llll upgrade <published-version>
sudo llll domain list
sudo llll domain add chat.example.com
sudo llll domain primary chat.example.com
sudo llll domain remove old.example.com
```

`llll domain` manages every public address of the Server. Point the new hostname's DNS at the VPS first, then `domain add`: the command appends the origin to `LLLL_ORIGINS`, adds the name to the Caddy site address, restarts Compose, waits for a certificate and verifies discovery at every listed address. A failed change restores the previous `.env` and restarts the old configuration. `domain primary` changes `PUBLIC_ORIGIN` without removing the old address. The primary cannot be removed; promote another address first. Alias changes are not written to D1, because the installer-managed VPS uses `PUBLIC_ORIGIN` and `LLLL_ORIGINS` as its authority.

An upgrade downloads the selected release's verified installer, checks SemVer (no downgrades), verifies/loads its runtime and takes a mandatory backup before changing the installation. If startup/discovery fails, it stops the failed stack and restores the old Compose, `.env`, CLI and all four volumes, then verifies the old version. The old image stays available locally for rollback. Single-node operations cause downtime. If recovery itself fails, the separate backup is retained and the command fails; inspect `llll logs` before further changes.

Backups stop the stack for consistency and include `.env`, deployment/CLI files, RustFS, celld and Caddy certificate/config volumes. They restart the stack even after an archive failure. Archives are mode 0600 under `/var/backups/llll/<installation-key>`; the latest seven are retained. Copy encrypted backups off-host and test restoration. celld stores its Worker variables in plaintext inside the private fleet bucket, so protect the VPS disk and backup archives as secrets.

Restore on a fresh host with the same DNS/origin, using a published installer script:

```sh
sudo env LLLL_DIR=/opt/llll bash install.sh restore /private/llll-backup-….tar.gz
```

The directory must not exist and all four target volumes must be empty. Restore verifies the archive, downloads/checks the backup's pinned runtime, restores the original secrets/UUID, and verifies discovery. Existing accounts, sessions and private files must work before switching traffic. The archive's origin is preserved; DNS should point at the restored host. Two simultaneous active copies of the same Server are unsupported.

```sh
sudo llll uninstall                    # confirms the exact project; backs up first
sudo llll uninstall --purge            # additionally removes this Server's live volumes
```

`--yes` is for unattended confirmation; `--no-backup` explicitly skips backup. Uninstall keeps configuration/CLI for recovery, all backup archives, Docker and shared images. It never prunes. It checks Compose ownership labels before touching live volumes. `llll start` restarts a retained installation; after `--purge`, restore a backup instead.

## Configuration

| Input | Default / meaning |
| --- | --- |
| `LLLL_DOMAIN`, `LLLL_ADMIN_EMAIL` | Required on first install. Domain without scheme/path; first owner email. |
| `PUBLIC_ORIGIN`, `LLLL_ORIGINS` | Primary origin and comma-separated aliases. Managed by `llll domain`; do not edit by hand. |
| `LLLL_DIR` | `/opt/llll`; canonical dedicated directory. Use the same value with each CLI command for a custom directory. |
| `LLLL_CHANNEL` | `stable`; prerelease install/upgrade needs explicit `prerelease`. Until a stable release exists, `llll upgrade` without a version cannot select one. |
| `LLLL_ACME_EMAIL` | Owner email, used for Caddy's ACME account. |
| `LLLL_HTTP_PORT`, `LLLL_HTTPS_PORT` | `80`, `443`; custom public TLS ports require forwarding public ACME challenge ports. |
| `LLLL_NO_TLS` | `false`; `true` enables HTTP for isolated tests/private development only. |
| `SERVER_ID` | Generated UUIDv4 saved to `.env`; it names the Server, its resources and its backups. |
| `LLLL_SKIP_DOCKER_INSTALL` | `false`; `true` requires an existing local Engine/Compose. |
| `LLLL_BACKUP_DIR` | Separate `/var/backups/llll/<installation-key>`; never inside `LLLL_DIR`. |
| `LLLL_BACKUP_KEEP` | `7`; first-install default saved to `.env`. |

Inputs are used on first install; reruns preserve saved values. To add providers, edit private `.env` using [the supported integration keys](../self-host/.env.example), then `llll start`. Version selection happens through the installer/release command, not by editing a version environment variable. Automatic updates, scheduled backups, ARM64 release artifacts and sslip.io fallback are deferred; non-default `LLLL_AUTOUPDATE`/`LLLL_BACKUP_SCHEDULE` inputs fail explicitly. Local ARM64 development is supported independently.

## Verification

`tests/unit/vps-release.test.ts` checks exact Compose/runtime/commit pins, Bash truncation and SemVer. `scripts/test-vps-installer.mjs` exercises the actual installer against a simulated Docker/network boundary in a disposable Linux container: tar/checksum tamper before host changes, rerun secret preservation, upgrade/downgrade, failure after persistent mutation and data rollback, backup/cold restore, foreign-resource refusal and precise purge.

```sh
docker run --rm -v "$PWD:/repo:ro" -w /repo node:24.21.0-bookworm-slim bash -c '
  apt-get update -qq &&
  apt-get install -y -qq curl jq openssl util-linux iproute2 >/dev/null &&
  node scripts/test-vps-installer.mjs'
```

The `self-host` CI job also runs `scripts/test-vps-live.mjs` on a real amd64 Docker daemon using the built Server, common Compose and HTTP Caddy override. It claims an owner, verifies messages/files/WebSockets, reruns install without rotating secrets, backs up, purges live data and restores the same UUID/session/message/file into a new installation. GitHub release downloads are redirected to generated checksum fixtures; this does not prove publication, apt installation on a fresh VM or public ACME.

Before advertising production one-command setup, record fresh Debian 12 and Ubuntu 24.04 VM runs with real DNS/HTTPS, browser owner/invite/chat/files/realtime, rerun identity, real N→N+1 upgrade/rollback, off-host cold restore and the published script digest/content type. Those checks require a new immutable release and disposable VPS targets; feature CI/Preview does not replace them.

## Optional Software Factory

From 0.2.14, a fresh install can opt in with `LLLL_FACTORY=true LLLL_SHARED_KERNEL_TRUSTED=1`. On an existing Server run `sudo llll factory enable --trust-shared-kernel`. The same pinned CLI verifies Node/workspace image release artifacts, checks Linux/Docker/disk/RAM/loop mounts, installs a private root systemd service and pairs it automatically after Owner claim. Shared-kernel Docker is for trusted code/users. No source build or registry is required.

Use `sudo llll factory status`, `logs`, `restart`, `disable`, `backup` and `remove --keep-source`. Source disks, credential/receipt journal and off-host backups are retained by disable/removal. Source disks are not part of the ordinary Server Compose backup; export them separately while the service is stopped. A changed workspace image is refused before stopping the existing service: preserve/export source, revoke the old Node and explicitly pair a replacement for new Tasks. Existing remote Nodes/environments are not replaced. See [Software Factory setup](software-factory.md) and [real-provider acceptance](software-factory-acceptance.md).
