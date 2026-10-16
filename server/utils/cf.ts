import type { H3Event } from 'h3'
import type { L4Env } from '../../workers/env'

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
  if (!env.FILES) fail(409, 'files_disabled', 'Files and backups are disabled. Enable R2 from this workspace’s L4 Admin, then reload the workspace.')
  return env.FILES
}

export function originOk(event: H3Event): boolean {
  const method = event.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true
  // Bundled clients cannot share the server's browser origin. The custom header
  // makes the request non-simple, so ordinary cross-origin web pages cannot use
  // this path without first passing CORS preflight.
  if (['native', 'extension'].includes(getHeader(event, 'x-llll-client') ?? '')) return true
  const origin = getHeader(event, 'origin')
  if (!origin) return true
  const host = getHeader(event, 'host')
  if (!host) return false
  try {
    const o = new URL(origin)
    return o.host === host
  }
  catch {
    return false
  }
}
