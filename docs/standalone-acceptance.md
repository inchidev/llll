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

## Held-socket revocation correction

A further real Cloudflare probe showed that a Channel socket authenticated before logout could still submit a message afterward. Alpha.3 publication was cancelled before any tag or release asset was created. The correction persists the local session ID in hibernating socket attachments and rechecks it before queued writes and every private fanout, including presence and agent updates. Authorizations are cached only per user and session within one fanout. Missing builtin session IDs fail closed.

The local fixture now holds sockets across member logout and owner recovery, denies revoked writes and passive fanout, and verifies that another independent session of the same user keeps working. These cases run with real Worker sockets, alongside the existing HTTP and pending-ticket revocation checks.

Cloudflare correction acceptance used PR #13 head `456fa35bbc1ef3e3021edf183240b443aca473a3`, Server `https://server-pr-13.llll.gg`, UUID `55aa8c4d-13c4-423d-88eb-79807f34a878`. Build `b120c4b4-25f2-4eaf-9c74-fae16244bb7e` succeeded and verified public discovery after initial domain propagation. Real HTTPS owner/login/message/private-file/realtime checks passed. The pre-fix held-socket logout probe accepted `message`; the same probe against this correction closed with code `4403`. The result was repeated after the successful Build. All 515 unit tests and exact-head CI/Compose checks passed.
