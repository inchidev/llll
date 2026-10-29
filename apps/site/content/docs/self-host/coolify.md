---
title: Run a Server on Coolify
description: Deploy one L4 Server in Coolify from the published image, claim the Owner, add addresses and update by redeploying or pinning a version.
order: 3
---

The Coolify template runs one standalone L4 Server: L4 on a single celld node with private RustFS storage. Coolify's proxy owns the domain and TLS. The template uses the published `ghcr.io/inchidev/llll` image. It is public, so Coolify pulls it without a registry login and nothing is built on your machine.

The template is [`self-host/coolify/docker-compose.yaml`](https://github.com/inchidev/llll/blob/main/self-host/coolify/docker-compose.yaml). It is not a published Coolify catalog entry yet.

## Install

1. In Coolify, choose **New Resource → Docker Compose** and paste the contents of `docker-compose.yaml`.
2. Set the domain of the `llll` service, on port `8080`, and `ADMIN_EMAIL` (the first Owner's email). The deployment fails without `ADMIN_EMAIL`. Leave `LLLL_VERSION` unset to run `latest`.
3. Deploy. The first start takes a few minutes while the database migrations are applied.
4. Wait until `https://<your-domain>/api/setup/health` answers with HTTP 200.
5. Open `https://<your-domain>/setup#claim=<SETUP_TOKEN>` and create the Owner. The token is the value of `SERVICE_PASSWORD_64_SETUPTOKEN` in the service's environment variables in Coolify.

If the Server does not come up, read the logs of the `llll` container in Coolify; see also [Troubleshooting](../reference/troubleshooting.md).

Coolify generates these values for the template:

| Variable | Used as |
| --- | --- |
| `SERVICE_URL_LLLL_8080`, `SERVICE_FQDN_LLLL_8080` | The Server's public origin (`PUBLIC_ORIGIN`). |
| `SERVICE_PASSWORD_64_AUTHSECRET` | `AUTH_SECRET`. Signs sessions and encrypts stored credentials. |
| `SERVICE_PASSWORD_64_SETUPTOKEN` | `SETUP_TOKEN`. The value for the setup link. |
| `SERVICE_USER_RUSTFS`, `SERVICE_PASSWORD_64_RUSTFS` | Keys for the private storage bucket. |

> [!IMPORTANT]
> Keep these values private and never regenerate them. A new `AUTH_SECRET` signs out everyone and makes stored credentials unreadable.

`APP_NAME` sets the initial name (default `L4`). You can rename the Server later in Settings.

## More addresses

To serve more domains, add them in Coolify and list every origin in `LLLL_ORIGINS`, comma-separated. The Server trusts only listed origins. RustFS has no public port.

## Updates

The image is built for `linux/amd64` and `linux/arm64`. Only stable releases are published as images, with three tags: the exact version (for example `0.3.5`), its minor line (`0.3`) and `latest`.

Updates are controlled in Coolify, not in L4:

- **Follow stable releases.** Leave `LLLL_VERSION` unset to use `latest`. Redeploy the service to pull the newest stable release.
- **Pin a version.** Set `LLLL_VERSION` to an exact version. Change it and redeploy to update.

On start, the new version applies its database migrations and skips ones already applied. Migrations only go forward: an older image refuses to start on data a newer one has migrated. If that happens, set a version at least as new as the one in the error.

In L4, **Server settings → Deployment → Updates** shows "Updates are managed outside L4" and tells you when a newer stable release exists.

![Server settings → Deployment → Updates on a Docker Server, showing the "Updates are managed outside L4" notice and a newer release link](screenshot:self-host-docker-updates "Docker and Coolify Servers update outside L4")

## Backups

Backups are optional but recommended before an update.

- **Server settings → Deployment → Backups** downloads the database and files, or sends them to an S3 destination.
- For a full copy, stop the service and archive the `rustfs-data` and `celld-data` volumes. A copy taken while the service runs may be inconsistent.

Keep backups outside these volumes. See [Files and backups](../concepts/files-and-backups.md).

## Optional providers

Cloudflare, AI and mail credentials are optional. The template accepts `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`, `MAIL_GATEWAY_URL`, `MAIL_GATEWAY_TOKEN`, `SMTP_GATEWAY_URL`, `SMTP_GATEWAY_TOKEN`, `LLLL_EMAIL_DOMAINS`, `MAIL_APP_HOSTNAME`, `MAIL_DEFAULT_LOCAL_PART`, `INBOUND_EMAIL_SECRET` and `BROWSER_CDP_URL`. See [Optional providers](docker.md#optional-providers) for what each one does.
