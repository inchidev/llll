# Coolify service draft

This Compose file is a draft for Coolify's one-click catalog. It is not in Coolify yet. For a VPS without Coolify, use [../README.md](../README.md).

Coolify generates the values below when it finds those names in the file:

| Variable | Use |
| --- | --- |
| `SERVICE_URL_LLLL_8080` | Public origin, including the scheme. Proxied to port 8080. Copied to `PUBLIC_ORIGIN`. |
| `SERVICE_FQDN_LLLL_8080` | Hostname only. |
| `SERVICE_PASSWORD_64_AUTHSECRET` | `AUTH_SECRET` (64 characters). |
| `SERVICE_PASSWORD_64_ADMINSETUP` | `ADMIN_SETUP_TOKEN` (64 characters). |
| `SERVICE_USER_RUSTFS` | RustFS access key, shared with the L4 container. |
| `SERVICE_PASSWORD_64_RUSTFS` | RustFS secret key, shared with the L4 container. |

Set `ADMIN_EMAIL` before the first deploy. Set `LLLL_VERSION` to a release tag that the image workflow has published, without the leading `v` (for example `0.2.4` for git tag `v0.2.4`). Optional `CLOUDFLARE_*`, `AI_*`, `MAIL_*`, `INBOUND_EMAIL_SECRET`, and `BROWSER_CDP_URL` can stay empty.

The image listens on 8080 inside the Compose network. Do not publish RustFS. Coolify's proxy terminates TLS and sends `SERVICE_URL_LLLL_8080` as `https://…`, which is the origin members open.

Coolify's default restart policy is `unless-stopped`. That brings the L4 container back after celld fences itself and exits. The image entrypoint waits 15 seconds on that restart so the old lease can expire. `rustfs-perms` and `bucket-init` set `restart: "no"` because they run once.

You can try the draft before it is in the catalog: **Create New Resource → Docker Compose Empty**, paste `docker-compose.yaml`, set `ADMIN_EMAIL` and `LLLL_VERSION`, and deploy. The image must already exist on GHCR.

## Submitting it to Coolify

Coolify's guide is [Add a new service template](https://coolify.io/docs/contribute/service). The checklist there is:

1. The GitHub repository needs at least 1,000 stars before Coolify will merge a one-click service.
2. Open a pull request against the `next` branch of [coollabsio/coolify](https://github.com/coollabsio/coolify).
3. Add this file as `templates/compose/llll.yaml`.
4. Add a logo and point the metadata at it. Coolify prefers SVG. This repository's mark is `public/brand/logo-128.png` and `public/favicon.svg` (the SVG wraps a PNG). Copy one to `svgs/llll.png` or `svgs/llll.svg` and set `# logo:` to that path.
5. Pin `ghcr.io/inchidev/llll` to a release the publish workflow has pushed. Do not use a floating `latest` tag in the template.
6. Test through Docker Compose Empty, not only a stack that is already running.
7. Open the matching docs pull request Coolify requires, and link it from the template pull request. Their guide describes the docs page, the `generate:services` step, and the frontmatter.

`templates/service-templates.json` is generated. Do not edit it by hand.

The template omits `container_name` and omits `restart` on the long-running services so Coolify can fill those in.
