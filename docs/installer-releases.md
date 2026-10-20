# Deployment artifacts

One release contains Server, Shell/site, client assets, Docs and matching migration chains. Deployment bundle and release provenance use schema version 3. The Server manifest declares `llll-server-schema-v1`; older formats are not install targets.

| Asset | Purpose |
| --- | --- |
| `llll-deployment.json` | Complete verified bundle: `site`, `client`, `server` modules; static assets; ordered Server migrations. |
| `llll-cloudflare-manifest.json` | Server runtime manifest with immutable asset URLs, hashes, compatibility flags and DO classes. |
| `llll-worker.mjs` | Bundled server Worker. |
| `llll-assets.json` | Server client assets and ordered server migrations. |
| `llll-deployment-core-<version>.tgz` | Provisioning library for Workers Builds and operator tooling. |
| `llll-runtime-linux-amd64.tar.gz` | Portable Docker image, tagged `llll:<version>`, loaded with `docker load`. |
| `llll.tgz` | Independently deployable web Worker (`llll`), public site/PWA assets and web migrations. |
| `llll-docs.tgz` | Docs, README and domain context from the release commit. |
| `llll-release.json` | Shared version, exact commit, release PR, component list and artifact hashes/sizes. |
| `install.sh`, `llll` | Identical pinned VPS installer/operator CLI, also embedded at `/install.sh` in `llll.tgz`. |
| `llll-compose.yml`, `compose.vps.yml`, `Caddyfile`, `Caddyfile.vps` | Exact common standalone Compose plus VPS HTTPS override. |
| `SHA256SUMS` | Checksums for every accompanying release file. |

`@llll/deployment-core` is a library used inside Workers Builds, not a deployed Admin or Server control plane. The browser-bound installer configures a Git-connected Build and removes its temporary encrypted OAuth grant after verified completion or expiry. Accounts, content and provider credentials remain on each Server.

Build with `pnpm release:installer`. Validate all module SHA-256, asset hashes/sizes, migration order and release provenance. Published tags and assets and merged SQL are immutable. The release workflow packages the portable runtime image and all components before publishing, then promotes the official web archive through Workers Builds.

Releases containing the VPS installer set `vpsInstaller: 1` in `llll-release.json`. Earlier immutable schema-3 releases remain valid Cloudflare targets. The release workflow exports the runtime first, generates installer pins, then builds the web archive with that exact installer. Finalization checks the public script and release asset byte for byte before publication. See [VPS installation](vps-installer.md).
