/**
 * The Server's document policy. `script-src` deliberately has no
 * `'unsafe-inline'`: the Nitro `beforeResponse` hook in
 * `server/plugins/csp-script-hashes.ts` appends a SHA-256 hash for each inline
 * script of every HTML response (Nuxt's import map, `window.__NUXT__` config,
 * the color-mode script and the few server-rendered callback pages).
 *
 * Remaining relaxations, kept on purpose:
 * - `style-src 'unsafe-inline'`: Vue/Nuxt UI bind inline `style` attributes and
 *   inject runtime `<style>` elements; CSP hashes cannot cover attributes.
 * - `connect-src https: wss: ws:`: Live (RealtimeKit), operator-configured
 *   providers and local development use origins the Client cannot enumerate.
 *   `ws:` is needed for Vite HMR on http://localhost.
 * - `https://telegram.org`: Telegram's Mini App SDK, loaded only when the
 *   Client opens inside Telegram.
 */
/**
 * Nuxt's built-in 404 page injects one fixed inline script at runtime (it
 * swaps "Home" for "Go back"). tests/unit/security-headers.test.ts recomputes
 * it from the installed Nuxt so an upgrade that changes it fails loudly.
 */
export const NUXT_ERROR_404_SCRIPT_HASH = "'sha256-Obm/pgvNhhb4DuoDisFDPpipssMoIKVJdm2bV3PvqR0='"

export function serverContentSecurityPolicy(frameAncestors: string): string {
  return [
    "default-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "connect-src 'self' https: wss: ws:",
    `script-src 'self' https://challenges.cloudflare.com https://telegram.org ${NUXT_ERROR_404_SCRIPT_HASH}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    'frame-src https://challenges.cloudflare.com',
    "object-src 'none'",
    `frame-ancestors ${frameAncestors}`,
    "base-uri 'self'",
  ].join('; ')
}

/**
 * OAuth backchannels use client authentication/PKCE, never browser cookies.
 * They answer CORS for any origin and skip the Origin check entirely.
 */
export const OAUTH_BACKCHANNEL_PATHS = new Set([
  '/api/auth/oauth2/token',
  '/api/auth/oauth2/register',
  '/api/auth/oauth2/revoke',
  '/api/auth/oauth2/introspect',
])

/**
 * Unsafe requests that may carry a stray Cookie header without browser fetch
 * metadata (`Origin` / `Sec-Fetch-Site`). Each path authenticates by something
 * other than the session cookie, so a cookie on it confers no authority:
 *
 * - OAuth provider callbacks (`/api/auth/callback/:id`,
 *   `/api/auth/oauth2/callback/:id`): normally GET; a POST callback is bound to
 *   the state cookie and the state parameter returned by the provider.
 * - Signed inbound mail webhooks (`/api/email/inbound/*`): provider signatures.
 * - Compute node endpoints (`/api/compute-agent/*`): pairing token, HMAC
 *   signature or node bearer token.
 * - Agent runtime capability requests (`/api/agent-runs/:id/gateway/*`): run
 *   capability bearer token.
 * - MCP (`/mcp`) only when it carries an `Authorization: Bearer` token.
 *
 * A *present* foreign `Origin` is still rejected on these paths, and the Host
 * must still be one of this Server's addresses.
 */
export function fetchMetadataExempt(path: string, authorization: string | undefined): boolean {
  if (/^\/api\/auth\/(?:callback|oauth2\/callback)\/[^/]+$/.test(path)) return true
  if (path === '/api/email/inbound' || path.startsWith('/api/email/inbound/')) return true
  if (path.startsWith('/api/compute-agent/')) return true
  if (/^\/api\/agent-runs\/[0-9a-f-]{36}\/gateway\//.test(path)) return true
  if (path === '/mcp' && /^Bearer\s+\S/i.test(authorization ?? '')) return true
  return false
}
