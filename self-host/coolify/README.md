# Coolify

[`docker-compose.yaml`](docker-compose.yaml) runs one standalone Server in Coolify: L4 on a single celld node with private RustFS storage. Coolify's proxy owns the domain and TLS. It is not yet a published catalog entry.

## Install

1. Create a Docker Compose resource from `docker-compose.yaml`.
2. Set `ADMIN_EMAIL` and the Server's domain. Coolify generates `SERVICE_URL_LLLL_8080`, `SERVICE_FQDN_LLLL_8080`, `SERVICE_PASSWORD_64_AUTHSECRET`, `SERVICE_PASSWORD_64_SETUPTOKEN`, `SERVICE_USER_RUSTFS` and `SERVICE_PASSWORD_64_RUSTFS`; keep them private and never regenerate them. `AUTH_SECRET` signs sessions and encrypts stored credentials.
3. Deploy. The Server is ready once `/api/setup/health` answers 200. Open `/setup`, enter the generated setup token (`SERVICE_PASSWORD_64_SETUPTOKEN`) and create the owner.

To serve more domains, add them in Coolify and list every origin in `LLLL_ORIGINS`, comma-separated. RustFS has no public port.

## Updates

The image is `ghcr.io/inchidev/llll`, built for `linux/amd64` and `linux/arm64`. Only stable releases are published: an exact version (`0.3.4`), its minor line (`0.3`) and `latest`. Prereleases are not published as images.

Updates are controlled in Coolify, not in L4 Settings:

- `LLLL_VERSION` unset uses `latest`. Redeploy the service to pull the newest stable release.
- To pin, set `LLLL_VERSION` to an exact version and change it to update.

On start, the new version applies its database migrations; ones already applied are skipped. Migrations only go forward, so an older image refuses to start on data a newer one has migrated: set a version at least as new as the one in the error. Settings → Updates shows when a newer release is available.

## Backups

Optional, but recommended before an update. Settings → Backups downloads the database and files, or sends them to an S3 destination. For a full copy, stop the service and archive the `rustfs-data` and `celld-data` volumes; a copy taken while it runs may be inconsistent. Keep backups outside these volumes.

Provider credentials (Cloudflare, AI, mail) are optional; see [self-host setup](../README.md#optional-integrations).
