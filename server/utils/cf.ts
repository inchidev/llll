import { fileStorage, type FileStore, type FileStorageEnv } from '../../shared/file-storage'
import type { H3Event } from 'h3'
import { createError } from 'h3'
import type { L4Env } from '../../workers/env'
import { allowedServerOrigins } from './server-origins'

export type Rpc<T> = { fetch: (request: Request) => Promise<Response> } & T

export function asRpc<T>(stub: unknown): Rpc<T> {
  return stub as Rpc<T>
}

export function cf(event: H3Event): { env: L4Env; request?: Request; waitUntil: (p: Promise<unknown>) => void } {
  const box = event.context.cloudflare as {
    env?: L4Env
    request?: Request
    context?: { waitUntil: (p: Promise<unknown>) => void }
  } | undefined
  const platform = event.context._platform as { cloudflare?: { env?: L4Env; request?: Request; context?: { waitUntil: (promise: Promise<unknown>) => void } } } | undefined
  const runtime = box ?? platform?.cloudflare
  const env = runtime?.env
  if (!env?.DB) {
    throw fail(503, 'unbound', 'Cloudflare bindings unavailable')
  }
  const waitUntil = runtime?.context?.waitUntil?.bind(runtime.context)
    ?? event.context.waitUntil?.bind(event.context)
    ?? ((p: Promise<unknown>) => { void p })
  return { env, request: runtime?.request, waitUntil }
}

export function fail(status: number, code: string, message: string): never {
  throw createError({
    statusCode: status,
    statusMessage: message,
    data: { error: { code, message } },
  })
}

export function requireFiles(env: FileStorageEnv): FileStore {
  return fileStorage(env)
}

export type OriginCheckOptions = {
  /**
   * The path authenticates by a token or signature, never the session cookie,
   * so a request without browser fetch metadata is acceptable even if it
   * happens to carry a Cookie header. A present foreign Origin is still denied.
   */
  allowMissingFetchMetadata?: boolean
}

/**
 * CSRF defence for unsafe methods. The session cookie is `SameSite=None`
 * (the Client runs inside the Shell's cross-site iframe), so the browser
 * attaches it to cross-site requests and this check is the boundary:
 *
 * 1. The Host must be one of this Server's addresses.
 * 2. A present `Origin` must be one of this Server's origins.
 * 3. A request that carries cookies but no `Origin` must carry
 *    `Sec-Fetch-Site: same-origin` or `none` (user-initiated). Without either
 *    header nothing proves it came from this Server's own pages.
 *
 * Requests with no Cookie header carry no ambient browser credential: bearer
 * tokens (MCP, native and extension clients, Shell popup sessions), signed
 * webhooks and machine clients need no fetch metadata. The `x-llll-client`
 * header is only honoured on such cookie-less requests, so a custom header can
 * never stand in for an Origin check on cookie-authenticated requests.
 */
export async function originOk(event: H3Event, options: OriginCheckOptions = {}): Promise<boolean> {
  const method = event.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true
  const origin = getHeader(event, 'origin')
  let origins: string[] = []
  try {
    const { env } = cf(event)
    origins = await allowedServerOrigins(env, getRequestURL(event).origin)
  }
  catch { /* Isolated handler tests may only supply Host. */ }
  // A Host that is not one of this Server's addresses must never authenticate.
  if (origins.length) {
    const request = getRequestURL(event)
    const hostname = request.hostname.toLowerCase()
    const port = request.port || (request.protocol === 'https:' ? '443' : '80')
    if (!origins.some((value) => {
      try {
        const listed = new URL(value)
        const listedPort = listed.port || (listed.protocol === 'https:' ? '443' : '80')
        return listed.hostname.toLowerCase() === hostname && listedPort === port
      }
      catch {
        return false
      }
    })) return false
  }
  const cookies = Boolean(getHeader(event, 'cookie')?.trim())
  // Bundled clients cannot share the server's browser origin. They authenticate
  // with bearer tokens; the header also makes the request non-simple, so a web
  // page cannot send it cross-origin without passing a CORS preflight.
  if (!cookies && ['native', 'extension'].includes(getHeader(event, 'x-llll-client') ?? '')) return true
  if (!origin) {
    if (!cookies || options.allowMissingFetchMetadata) return true
    const site = getHeader(event, 'sec-fetch-site')?.trim().toLowerCase()
    return site === 'same-origin' || site === 'none'
  }
  let normalized: string
  try { normalized = new URL(origin).origin } catch { return false }
  // Opaque origins (sandboxed frames, cross-origin redirects) are never ours.
  if (normalized === 'null') return false
  if (origins.length) return origins.includes(normalized)
  let configured: string | undefined
  try { configured = cf(event).env.PUBLIC_ORIGIN } catch { /* See above. */ }
  if (configured) {
    try { return normalized === new URL(configured).origin } catch { return false }
  }
  const host = getHeader(event, 'host')
  if (!host) return false
  try {
    return new URL(origin).host === host
  }
  catch {
    return false
  }
}
