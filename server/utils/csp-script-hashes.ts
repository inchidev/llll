import type { H3Event } from 'h3'
import { policyForHtml } from '../../shared/security-headers'

/**
 * `script-src` has no `'unsafe-inline'`. Every HTML document this Server
 * renders (Nuxt's SPA shell with its import map, `window.__NUXT__` config and
 * color-mode script, and the small server-rendered callback pages) gets a
 * SHA-256 source for each of its own inline scripts, computed from the exact
 * body that is sent. Injected markup cannot match those hashes. Registered as
 * a Nitro `beforeResponse` hook in server/plugins/csp-script-hashes.ts.
 */
export async function applyInlineScriptHashes(event: H3Event, body: unknown): Promise<void> {
  if (typeof body !== 'string' || !body.includes('<script')) return
  const policy = getResponseHeader(event, 'content-security-policy')
  if (typeof policy !== 'string' || !policy) return
  const type = getResponseHeader(event, 'content-type')
  // h3 sends string bodies as text/html unless a handler chose another type.
  if (type !== undefined && !String(type).toLowerCase().includes('text/html')) return
  setResponseHeader(event, 'Content-Security-Policy', await policyForHtml(policy, body))
}
