# Put installation authority in an account-local L4 Admin

Status: accepted; supersedes ADR 0003 and ADR 0004.

## Context

ADR 0003 kept one renewable Cloudflare OAuth credential in the llll.gg Control Plane and let workspaces request fixed infrastructure operations with an Installation Control Credential. That left every workspace dependent on llll.gg for updates, domains, and mail, gave each workspace several credentials (control, mail gateway, RealtimeKit), and split one contract across two repositories: the installer wrote environment variables that the workspace release had to read.

Cloudflare OAuth cannot create API tokens (no OAuth scope grants token creation), and RealtimeKit has no Worker binding, so the server that talks to Cloudflare must hold a Cloudflare credential. The question is only which Worker holds it.

## Decision

Each Cloudflare account that runs L4 has one **L4 Admin**: a small Worker named `llll-admin`, served on `workers.dev`, released from this repository together with the workspace.

- **The Admin is the only holder of a Cloudflare credential in the account.** It is either the Admin's own OAuth grant, refreshed with the public L4 client ID, or an account API token the owner pasted. It is encrypted in the Admin's D1 database. Workspaces hold no Cloudflare credential.
- **The Admin owns installation lifecycle.** It creates, discovers, adopts, updates, and removes workspaces; connects App Domains, Email Domains, and mailbox routes; provisions one RealtimeKit app with host and participant presets per workspace; and updates itself from L4 releases.
- **Workspaces reach the Admin over a service binding, not a token.** Each workspace gets `LLLL_ADMIN`, bound to the Admin's `WorkspaceControl` entrypoint with `props.workerName` set to that workspace. Cloudflare guarantees `ctx.props` cannot be forged by the caller, so the Admin knows which workspace is calling and serves only that workspace. Live media, domain, mail, and update requests use this binding. A workspace without the binding keeps working with its manual settings (for example a pasted RealtimeKit token).
- **One release, one contract.** A L4 release manifest pins and verifies both the workspace and Admin bundles. The same GitHub Release also carries `packages/admin-core`, the deployment engine used by both Workers; llll.gg consumes that package from the exact release tag.
- **llll.gg keeps no Cloudflare credential at rest.** Its account identity (Cloudflare, Telegram, Google, or email one-time code) is separate from Cloudflare connections. Deploying an Admin uses a Cloudflare OAuth grant only for the duration of that request; the refresh token is handed to the new Admin as a Worker secret and llll.gg does not keep it. Reconnecting later runs a PKCE relay: the Admin creates the verifier, llll.gg only forwards the authorization code to that Admin, and cannot redeem it.
- **The directory is voluntary.** A deployed Admin enrolls with the L4 Account that created it and sends a heartbeat with its version and health. llll.gg lists Admins from those heartbeats and links to them; it cannot reach into an account.
- **Primary is retired.** The Admin replaces the Primary workspace as the owner of account- and zone-wide integrations. Existing Primary mail routing keeps working until the Admin adopts the account.

## Consequences

- Workspaces continue to run, update, and change domains when llll.gg is unavailable. llll.gg is needed only to create an Admin and to relay an OAuth reconnect.
- A compromise of a workspace no longer exposes a Cloudflare credential. A compromise of the Admin does; the Admin keeps a small surface (owner UI and a typed RPC entrypoint, no chat or Agents), and a dedicated Cloudflare account remains the isolation boundary.
- An OAuth grant belongs to the Cloudflare user who approved it. If that person leaves the account or revokes the grant, the Admin reports the lost connection and asks for a reconnect or a pasted account token.
- Existing guided installations are adopted when an Admin is deployed into their account: the Admin discovers them, rebuilds their domain and mailbox state from Cloudflare, adds `LLLL_ADMIN`, and removes the Installation Control Credential.
- Managed hosting reuses `admin-core`; running Admins for customers in L4-owned accounts is a later product decision.
