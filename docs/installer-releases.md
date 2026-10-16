# L4 installer releases

One L4 GitHub Release carries a matching workspace Worker, account-local
L4 Admin, and the shared provisioning engine. The Admin consumes these
artifacts to install and update workspaces in its Cloudflare account.
`llll.gg` consumes the same pinned provisioning package only to create or
reconnect an Admin; it does not keep a Cloudflare credential or manage a
workspace directly. The Cloudflare Deploy Button remains the source-build path
for independent installations.

## Release artifacts

`pnpm release:installer` produces six files:

| Artifact | Purpose |
| --- | --- |
| `llll-cloudflare-manifest.json` | Version, compatibility settings, Durable Object migrations, capabilities, and SHA-256 metadata for both Workers. |
| `llll-worker.mjs` | Bundled workspace Worker. |
| `llll-assets.json` | Workspace static assets and ordered D1 migrations. |
| `llll-admin.mjs` | Bundled account-local Admin Worker. |
| `llll-admin-assets.json` | Admin static assets. |
| `llll-admin-core-<version>.tgz` | Public `@llll/admin-core` package consumed from the exact release tag by `llll.gg`. |

The manifest pins and verifies the workspace and Admin Worker payloads. The
versioned `admin-core` package is a companion asset in the same GitHub Release;
it is not nested in the manifest.

## Publishing a release

Before creating a tag, confirm in the repository settings that GitHub native
release immutability is enabled. The standard workflow token cannot read or
change that Administration setting, so this is a maintainer-owned release gate.

Release tags use `v<version>` and must match `package.json`. Pushing the tag
triggers `.github/workflows/publish-installer-release.yml`. The workflow:

1. Checks out the exact protected tag rather than an unversioned branch.
2. Builds the workspace and Admin with the Node version pinned in
   `.node-version` (currently Node 24.21.0), without deploying either Worker.
3. Creates or updates a draft GitHub Release and uploads the six artifacts.
4. Verifies that the draft contains exactly the locally built artifact set.

If a tag-triggered run fails before the draft is ready, use **Run workflow** on
the same workflow and enter the existing protected tag. The manual recovery path
checks out and rebuilds that tag; it never moves or replaces it.

A maintainer reviews the draft and publishes it only after the workflow passes.
Draft assets may be replaced when repairing a failed build. Publication freezes
the release tag, description, and assets; never publish an empty release and
expect the workflow to attach files later. GitHub applies native immutability
only to releases published after the repository setting was enabled.

## Installation and updates

The Admin reads the requested release manifest, verifies every referenced
payload against its SHA-256 digest, and applies a workspace update in place
while reusing its D1, R2, KV, Durable Object, domain, mail, and Live resources.
The workspace contains a `LLLL_ADMIN` service binding but no Cloudflare
credential. Workspaces created before the Admin architecture retain their
Installation Control Credential until the Admin adopts and updates them.

Before deploying an updated workspace Worker, `admin-core` reads
`d1_migrations` from its D1 database and applies every missing release migration
in filename order. Each migration and its marker execute in the same D1 batch.
A failed or unrecorded migration stops the update. The installer does not create
an automatic backup; the owner can first download one or upload one to a
configured S3-compatible bucket from **Workspace Settings → Backups**.

Updates, setup links, and deletion are initiated in the account-local Admin.
Workspace deletion still requires the one-use authorization started by the
workspace Owner from **Workspace Settings → Danger Zone**. The workspace
empties its own files before the Admin removes its managed Cloudflare resources.
Independent manual deployments remain outside automatic resource deletion.

## Building locally

Use the exact Node version in `.node-version`, then run:

```sh
pnpm install --frozen-lockfile
pnpm release:installer
```

Generated files are written to `.installer/release` and are excluded from Git.
