/**
 * Response security headers shared by the Server (Nitro) and the official
 * Shell/Landing Worker (`apps/site`).
 */

/**
 * Live calls need camera, microphone and screen capture for the Client's own
 * origin (it delegates nothing further). Features no Client code uses are
 * disabled outright.
 */
export const SERVER_PERMISSIONS_POLICY = [
  'camera=(self)',
  'microphone=(self)',
  'display-capture=(self)',
  'geolocation=()',
  'payment=()',
  'usb=()',
  'serial=()',
  'hid=()',
  'bluetooth=()',
  'midi=()',
].join(', ')

/**
 * The Shell embeds each Server's Client from an origin the Shell cannot know in
 * advance, and delegates Live permissions to it with the iframe `allow`
 * attribute. A top-level `camera=(self)` would forbid that delegation, so the
 * Shell leaves camera, microphone, display-capture, fullscreen and clipboard at
 * their defaults and only disables features neither the Shell nor the Client use.
 */
export const SHELL_PERMISSIONS_POLICY = [
  'geolocation=()',
  'payment=()',
  'usb=()',
  'serial=()',
  'hid=()',
  'bluetooth=()',
  'midi=()',
].join(', ')

const LOCAL_HOSTNAME = /^(?:localhost|127\.0\.0\.1|\[::1\]|.+\.localhost)$/i

/**
 * HSTS only makes sense on HTTPS and is ignored by browsers on HTTP. It is
 * never sent for loopback/`.localhost` development hosts so a local HTTPS
 * proxy cannot pin HTTPS for unrelated local development servers.
 */
export function strictTransportSecurity(url: URL, forwardedProto: string | null | undefined, includeSubDomains: boolean): string | null {
  if (LOCAL_HOSTNAME.test(url.hostname)) return null
  const proto = url.protocol === 'https:' ? 'https' : forwardedProto?.split(',')[0]?.trim().toLowerCase()
  if (proto !== 'https') return null
  return `max-age=31536000${includeSubDomains ? '; includeSubDomains' : ''}`
}

/** Script element types that a browser executes, so CSP `script-src` governs them. */
const EXECUTABLE_SCRIPT_TYPES = new Set(['', 'text/javascript', 'application/javascript', 'module', 'importmap', 'speculationrules'])

const INLINE_SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi
const TYPE_ATTRIBUTE = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i
const SRC_ATTRIBUTE = /\bsrc\s*=/i

const hashCache = new Map<string, string>()

async function sha256Base64(value: string): Promise<string> {
  const cached = hashCache.get(value)
  if (cached) return cached
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  let binary = ''
  for (const byte of digest) binary += String.fromCharCode(byte)
  const hash = `'sha256-${btoa(binary)}'`
  if (hashCache.size > 256) hashCache.clear()
  hashCache.set(value, hash)
  return hash
}

/**
 * CSP source expressions for every executable inline `<script>` in an HTML
 * document. Script contents are raw text in HTML, so the bytes between the
 * tags are exactly what the browser hashes. JSON data blocks are not executed
 * and need no hash.
 */
export async function inlineScriptHashes(html: string): Promise<string[]> {
  const hashes = new Set<string>()
  for (const match of html.matchAll(INLINE_SCRIPT)) {
    const attributes = match[1] ?? ''
    const body = match[2] ?? ''
    if (SRC_ATTRIBUTE.test(attributes) || !body) continue
    const type = TYPE_ATTRIBUTE.exec(attributes)
    const value = (type?.[1] ?? type?.[2] ?? type?.[3] ?? '').trim().toLowerCase()
    if (!EXECUTABLE_SCRIPT_TYPES.has(value)) continue
    hashes.add(await sha256Base64(body))
  }
  return [...hashes]
}

/** Add source expressions to the `script-src` directive of a policy. */
export function withScriptSources(policy: string, sources: string[]): string {
  if (!sources.length) return policy
  const directives = policy.split(';').map(part => part.trim()).filter(Boolean)
  const index = directives.findIndex(part => /^script-src(?:\s|$)/i.test(part))
  if (index === -1) directives.push(`script-src 'self' ${sources.join(' ')}`)
  else directives[index] = `${directives[index]} ${sources.join(' ')}`
  return directives.join('; ')
}

/** Allow the document's own inline scripts by hash in the given policy. */
export async function policyForHtml(policy: string, html: string): Promise<string> {
  return withScriptSources(policy, await inlineScriptHashes(html))
}
