# Standalone Server acceptance

Local evidence for the standalone transition; Cloudflare release and device results must be recorded separately.

The two-Server fixture passed fresh owner setup, distinct stable UUIDv4 identity before/after setup, internal UUID workspace routes, invitation/signup, messages, same-email account separation, HTTP and file denial, member removal, real WebSocket authentication, cross-server ticket denial, logout and recovery revocation, PKCE code/replay checks, signed bearer sessions without a cookie, separate files and backup storage, and restore preserving the UUID with clean foreign keys.

Chromium exercised the web Shell with both independently served Clients: address connection, local owner login, switching Alpha/Beta, returning to Alpha with its session, reloading a deep channel URL, and 1280px/390px layouts. Screenshots and synthetic fixture credentials are in ignored `.deployment/integration/`. These viewport checks are not physical-device or native iOS acceptance. Expected unauthenticated 401 responses are not application failures.

Unit tests, root/Shell/deployment-core/frozen-client type checks, immutable migration validation and builds are checked independently. Native packaging remains frozen. Optional RealtimeKit, mail and inference credentials are outside this core acceptance.
