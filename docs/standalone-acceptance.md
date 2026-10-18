# Standalone Server acceptance

Local evidence for the standalone transition; Cloudflare release and device results must be recorded separately.

The two-Server fixture passed fresh owner setup, distinct stable UUIDv4 identity before/after setup, internal UUID workspace routes, invitation/signup, messages, same-email account separation, HTTP and file denial, member removal, real WebSocket authentication, cross-server ticket denial, logout and recovery revocation, PKCE code/replay checks, signed bearer sessions without a cookie, separate files and backup storage, and restore preserving the UUID with clean foreign keys.

Chromium exercised the web Shell with both independently served Clients: address connection, local owner login, switching Alpha/Beta, returning to Alpha with its session, reloading a deep channel URL, and 1280px/390px layouts. Screenshots and synthetic fixture credentials are in ignored `.deployment/integration/`. These viewport checks are not physical-device or native iOS acceptance. Expected unauthenticated 401 responses are not application failures.

Unit tests, root/Shell/deployment-core/frozen-client type checks, immutable migration validation and builds are checked independently. Native packaging remains frozen. Optional RealtimeKit, mail and inference credentials are outside this core acceptance.

## Cloudflare Preview, 2026-10-18

PR #11 head `e95330b3e15a8bda4bba463d8819d27bca8dfe87` passed all CI jobs, including the independent runtime fixture and Compose smoke. Workers Builds `ad63e2ab-3a63-42b6-89f1-c5e0efd4b9e6` successfully deployed and verified the independent Server at `https://server-pr-11.llll.gg`, UUID `9683f642-7a90-4cac-925e-e31db511da37`. The official site Preview was `https://codex-standalone-server-shell.dev.llll.gg` and reported the same source head. Production stayed on alpha.2 during feature verification.

Real HTTPS checks passed owner setup, persistent UUID, local login, forged-identity denial, messages, private file upload/read and anonymous denial, WebSocket authentication, discovery CORS and embedding. A second invited account signed up, sent a message with the Server UUID, and lost access after removal. Chromium connected the deployed Server through the deployed Shell, signed in and preserved its session and deep channel URL on reload. Local DNS retained a negative answer after first provisioning; the local checks used the public DNS answer with normal certificate verification. The successful Cloudflare Build independently verified public discovery.

First-domain verification exposed propagation delays; a manual retry exposed missing webhook commit metadata. The final scripts allow a bounded longer propagation wait and verify the checked-out Git commit against the current PR head and both merge parents. Server deployment persists the private owner claim before public verification and repairs it on an unclaimed-server retry.

This is not public installer OAuth acceptance. The connected Cloudflare API refused OAuth-client registration reads, so registered Workers Builds scopes and fresh browser consent were not established. The installer needs the account's repository integration, deployment token and Builds administrative permission. Device/native and optional provider results remain separate.
