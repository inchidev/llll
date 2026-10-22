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

export function requireFiles(env: Pick<L4Env, 'FILES'>): R2Bucket {
  if (!env.FILES) fail(409, 'files_disabled', 'Files and backups are disabled. Ask the server operator to configure file storage for this server, then reload.')
  return env.FILES
}

export async function originOk(event: H3Event): Promise<boolean> {
  const method = event.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true
  // Bundled clients cannot share the server's browser origin. The custom header
  // makes the request non-simple, so ordinary cross-origin web pages cannot use
  // this path without first passing CORS preflight.
  if (['native', 'extension'].includes(getHeader(event, 'x-llll-client') ?? '')) return true
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
  if (!origin) return true
  let normalized: string
  try { normalized = new URL(origin).origin } catch { return false }
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
