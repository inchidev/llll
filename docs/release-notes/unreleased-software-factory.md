# Unreleased: Software Factory MVP

PR #337 implements a reviewed Task-to-PR workflow for existing GitHub repositories. It does not publish a release or change production.

- Exact private action review binds arguments, identities, Task/conversation, repository/base/ref, connection, workspace revision, pinned image and expiry. Current Role/delegation/resource checks apply before execution and throughout Node leases. Uncertain effects are held for inspection and never replayed automatically.
- Linux Compute Nodes pair through a one-use Owner code and connect outward to Cloudflare or VPS Servers. Task workspaces retain full pinned Git history, edits, local commits and dependency caches on fixed-capacity ext4 disks. Fresh non-root containers enforce CPU/memory/PID/time/network limits; the trusted Node alone controls Docker and loop mounts.
- The Server publishes exact reviewed local commit/tree SHAs to one dedicated branch and draft PR in the original repository. Existing GitHub Actions and preview deployments remain authoritative. Exact-head failure logs support a new approved repair in the same workspace and PR; absent/skipped/incomplete evidence is explicit.
- Settings provides Node pairing/revocation and repository provider selection. Private Runs show requests, exact diffs, test receipts, review decisions and canonical PR/CI/Preview links. Tasks show coarse workflow state without exposing private source content.
- Native Pi shell tools remain disabled. Workspace containers receive no Git provider credential, Server secret or Docker socket. A separate trusted source broker temporarily uses one single-repository read capability and exports a bundle; Git write credentials and App keys stay on the Server.

See [operator setup, limits and verification](../software-factory.md). Real afterprompt/GitHub installation, public Server topology, loop-quota/reboot and desktop/mobile acceptance remains with the operator's Grok bot. Docker shares the host kernel and is restricted to trusted-code use; hostile public tenants require stronger isolation. No implicit merge, release or production deployment is included.
