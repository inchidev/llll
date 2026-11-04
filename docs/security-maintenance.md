# Security maintenance

[SECURITY.md](../SECURITY.md) defines reporting and release support;
[CONTRIBUTING.md](../CONTRIBUTING.md) defines the contribution workflow.

## Dependency updates

`.github/dependabot.yml` checks the root pnpm workspace, GitHub Actions,
Dockerfiles and self-host Compose images weekly. npm runtime and tooling
minor/patch updates are grouped separately; major npm updates remain individual
PRs. Routine npm updates have a seven-day cooldown. Security updates are not
delayed by that cooldown or the version-update PR limit. Native Cargo routine
updates are disabled while native publication is frozen; security updates remain
enabled. No bot PR is automatically approved, merged, released or deployed.

Keep related versions compatible across workspace manifests and Dockerfiles:
especially Node/pnpm, the MCP SDK family, authentication adapters, Nuxt and
the Pi runtime. A bot's isolated version bump does not prove compatibility.
Docker image updates need the relevant self-host/agent smoke checks. A native
dependency fix does not establish that a patched native binary was published.

Review urgent security alerts as they arrive and review the remaining update
queue weekly. Assess affected paths, runtime/build exposure, prerequisites,
upstream fixes and compatibility. A dependency match is not proof of reachable
exploitation. Prioritize critical/high reachable findings; record a reason and
follow-up when deferring a finding. Prefer upstream/parent fixes over overrides;
any necessary exception needs a specific advisory, rationale, owner and review
date. Do not disable the scanner or broadly ignore a package/severity.

Update through focused PRs, validate the lockfile with a frozen installation,
run affected tests and verify the deployed Preview. Merge to `main` only after
required checks; publish a separate release and give operators actionable
upgrade instructions. Never patch immutable release assets in place.

## Checks and limits

- `dependency-review` rejects PRs introducing known high/critical vulnerable
  dependencies in runtime, development or unknown scopes. It also handles
  merge-group comparisons and does not install PR code or write PR comments.
  It compares changes; it does not clear the existing vulnerability backlog.
- `dependency-audit` runs `pnpm audit --audit-level high` daily and on manual
  dispatch, using the existing lockfile without installing packages. It fails
  on existing high/critical findings, including advisories published since the
  last dependency change. Run the same command locally to reproduce. This
  covers npm advisories, not OS packages or container-image CVEs.
- CodeQL scans JavaScript/TypeScript and GitHub Actions on PRs, pushes to
  `main`, merge groups, daily schedules and manual dispatch. It uses the
  extended security query suite without building or installing application
  dependencies. A successful analysis means the scan ran; findings must be
  reviewed in GitHub's Code scanning view. The separate `CodeQL` result check
  blocks newly introduced findings at GitHub's configured failure threshold
  (high-or-higher security alerts and standard errors). This is not a claim
  that the existing code has no vulnerabilities.
- GitHub secret scanning and push protection look for supported secret patterns.
  Review private alerts and revoke/rotate exposed credentials; deleting a file
  or dismissing an alert does not invalidate a credential. Never copy secret
  values into issues, PRs, scan summaries or CI logs.

These checks need no repository secrets or `pull_request_target`. They do not
replace manual review of Server authorization/isolation, OAuth, file access,
backups, agent permissions or the customer installer. Dependabot cannot update
every hardcoded version in scripts or every host/OS dependency; review those
alongside image and runtime updates. Native Swift/Rust code and container OS
packages are outside this CodeQL/npm-audit baseline.

## GitHub settings checklist

Repository admins should verify these settings after setup and periodically:

- Dependency graph, Dependabot alerts and Dependabot security updates enabled.
- Private vulnerability reporting enabled, with the report link in SECURITY.md.
- Secret scanning and secret push protection enabled.
- CodeQL advanced setup uses the committed workflow; do not enable a duplicate
  default-setup configuration.
- `main` requires PRs, resolved review conversations, the existing CI/Workers
  Builds checks, `dependency-review`, both CodeQL analysis jobs and the `CodeQL`
  findings check. Keep
  force pushes/deletion blocked and preserve immutable release-tag rules.
- Actions tokens default to read-only and cannot approve PRs. Fork workflows
  receive no write tokens or secrets. Require review of outside workflow runs.

Settings live on GitHub, not in these Markdown files. Verify them through the
repository API/UI instead of treating this checklist as proof they are enabled.
Maintainers should subscribe to repository security-alert notifications and
failed scheduled Actions runs in their own GitHub notification preferences.
Private reporting and scheduled workflows do not guarantee somebody receives
email if their personal notification settings disable it.
