# Release process

`main` is the protected, releasable L4 trunk. Completed work accumulates
there through short-lived feature and fix branches. It may be ahead of the
latest published version; immutable version tags identify released code.

## Branch flow

```text
feature/audio-messages ─┐
feature/another-change ─┼─> PR ─> main ─> release PR ─> tag and GitHub Release
fix/a-bug              ─┘
```

- Branch from current `main` and open focused feature and fix PRs directly back
  to `main`.
- Keep `main` green and releasable. Incomplete work stays on its branch or behind
  an explicit feature boundary.
- Squash feature and fix PRs so `main` contains one reviewable commit per change.
- Accumulate any number of completed changes before publishing a release.
- Use a short-lived release branch only for version, release-note, or other
  release-specific edits. It is not a second review of already merged changes.

## Pull request checks

`.github/workflows/ci.yml` runs on every PR targeting `main` and on pushes to
`main`. It reads Node.js from `.node-version`, pnpm from
`package.json#packageManager`, and installs the lockfile dependencies before
running five independent checks: `lint`, `typecheck`, `test`, `build`, and
`migrations`.
Failed checks do not cancel the other checks; a newer update to the same PR or
branch cancels its superseded run.

All CI and release-producing workflows read the exact local runtime from
`.node-version` (currently Node.js 24.21.0). Node.js 24 is required because the
backup tests use `node:sqlite` to read text containing NUL bytes; Node.js 22
truncates those values when returning them to JavaScript. CI uses Vitest's
default text reporter because the GitHub annotations reporter crashes the
runner while reporting the large Unicode diff from that failing test.

Configure the GitHub ruleset targeting `main` to require those five checks from
GitHub Actions. Require PRs and resolved review conversations, allow only squash
merges, block force pushes and deletion, and keep required approvals at zero
while the maintainer is the only reviewer.

CI builds the Worker without deploying or applying remote migrations. Browser
checks and release artifact verification remain separate release gates. A
separate workflow deploys same-repository pull requests as isolated Cloudflare
Worker Previews; it does not publish a release or change the production Worker.
See [Worker Previews](./worker-previews.md) for configuration, isolation, and
cleanup details.

## Preparing a release

When `main` contains the intended release contents, create a short-lived release
branch from it. The release PR must:

1. Pass lint, type checking, tests, and the production build.
2. Exercise representative browser and runtime paths in the sandbox.
3. Set the release version in `package.json`.
4. Build the Cloudflare installer artifacts and inspect the release manifest.
5. Update deployment documentation for new requirements or migrations.
6. Prepare the user-facing release notes.

Use Semantic Versioning while the product is pre-1.0:

- `0.0.x` for fixes and modest feature batches.
- `0.x.0` for a meaningful product milestone or breaking change.
- `1.0.0` when compatibility and operational guarantees are stable.

## Publishing

After the release PR is merged:

1. Confirm GitHub native release immutability is enabled for the repository. It
   affects only releases published after it is enabled.
2. Confirm `main` is at the intended release commit.
3. Create the protected Git tag `v<version>` from that commit and push it.
4. Wait for `.github/workflows/publish-installer-release.yml` to create and
   populate the draft GitHub Release.
5. Verify the draft has the expected version and all six artifacts documented
   in [L4 installer releases](./installer-releases.md).
6. Review its title and Markdown description, then publish the draft.
7. Confirm the published release reports itself as immutable and that its asset
   digests match the manifest.

The tag workflow builds the workspace and Admin Workers, packages their static
assets and D1 migrations, and packs the matching `@llll/admin-core`
package. The account-local Admin and `llll.gg` consume exact release URLs
rather than an unversioned branch.

Do not move an existing release tag or overwrite a broken version. Fix the
problem and publish the next patch release.

## Release notes

Release descriptions are a user-facing changelog, not a raw list of commits.
Include what changed, operational consequences, upgrade instructions, and
known limitations.

```md
## What's new

- Record and send audio messages.
- Play audio attachments directly inside conversations.

## Fixes

- Describe user-visible fixes.

## Deployment

Mention installer compatibility, new Cloudflare bindings or permissions,
migrations, and any manual actions required by GitHub/Workers Builds users.

## Known limitations

- Live sessions require RealtimeKit and internet connectivity.

**Full changelog:** v0.0.1...v0.0.2
```

## Hotfixes

For an urgent production fix:

1. If `main` contains only changes safe for the patch, branch from `main` and
   open a focused PR back to `main`.
2. If `main` contains unreleased changes that must not ship, branch from the
   latest release tag, publish the patch from that branch, and then apply the
   fix forward to `main` through a separate PR.
3. Publish the next immutable patch tag and GitHub Release.
