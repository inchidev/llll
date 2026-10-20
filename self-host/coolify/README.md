# Coolify operator template

This is an advanced standalone-Server template, not a published one-click catalog entry. For the shared Compose and local development flow see [self-host setup](../README.md) and [local development](../../docs/local-development.md). VPS/celld transport must be verified separately from Cloudflare; the VPS installer is follow-up work.

1. Download the intended release's `llll-runtime-linux-amd64.tar.gz` and `SHA256SUMS` on the Coolify host. Verify the archive, then load it with `docker load --input llll-runtime-linux-amd64.tar.gz`.
2. Create a Docker Compose resource using `docker-compose.yaml`. Set `LLLL_VERSION` to the exact loaded version, such as `0.1.0-alpha.1`, without `v`. The template uses the local image and does not pull a registry tag.
3. Set the owner email and keep generated authentication, setup and storage credentials private. Configure the public origin and TLS before inviting anyone. RustFS stays private.
4. Verify owner setup, membership, files, realtime and direct-link reloads. Resource creation or health 200 alone does not establish readiness.

Coolify supplies `SERVICE_URL_LLLL_8080`, `SERVICE_FQDN_LLLL_8080`, `SERVICE_PASSWORD_64_AUTHSECRET`, `SERVICE_PASSWORD_64_SETUPTOKEN`, `SERVICE_USER_RUSTFS` and `SERVICE_PASSWORD_64_RUSTFS` for the existing template. Preserve those values and storage volumes when updating. Do not apply the fresh alpha baselines to prototype databases.

Provider credentials are optional and separate from identity. Backups need a destination independent of live storage. Catalog submission, if pursued later, follows the then-current [Coolify contribution guide](https://coolify.io/docs/contribute/service).
