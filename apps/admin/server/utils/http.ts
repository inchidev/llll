import type { H3Event } from 'h3'
import type { AdminEnv } from '../env'

export function fail(statusCode: number, message: string): never {
  throw createError({ statusCode, statusMessage: message, data: { error: { message } } })
}

export function adminEnv(event: H3Event): AdminEnv {
  const box = event.context.cloudflare as { env?: AdminEnv } | undefined
  const env = box?.env ?? (globalThis as { __adminEnv__?: AdminEnv }).__adminEnv__
  if (!env?.ADMIN_DB) fail(503, 'Admin bindings are unavailable')
  return env
}

export function waitUntil(event: H3Event, work: Promise<unknown>) {
  const box = event.context.cloudflare as { context?: { waitUntil: (p: Promise<unknown>) => void } } | undefined
  box?.context?.waitUntil(work.catch(error => console.warn('Background work failed', error)))
}

/** Mutations must come from the Admin UI: same origin and a custom header a cross-site form cannot send. */
export function assertMutation(event: H3Event) {
  if (getHeader(event, 'x-llll-admin') !== '1') fail(403, 'Missing Admin request header')
  const origin = getHeader(event, 'origin')
  if (origin && origin !== getRequestURL(event).origin) fail(403, 'Cross-site request refused')
}

export function errorMessage(error: unknown, fallback = 'The Admin could not complete the request'): string {
  if (error && typeof error === 'object') {
    const value = error as { statusMessage?: unknown, message?: unknown }
    if (typeof value.statusMessage === 'string' && value.statusMessage) return value.statusMessage
    if (typeof value.message === 'string' && value.message) return value.message
  }
  return fallback
}

export type Progress = { type: 'progress', step: string, state: 'active' | 'complete', detail?: string }
  | { type: 'complete', result: unknown }
  | { type: 'error', message: string }

/**
 * Runs a long Cloudflare operation and streams its progress as NDJSON. The
 * work keeps running while the browser stays connected.
 */
export function progressStream(event: H3Event, run: (report: (value: Progress) => Promise<void>) => Promise<unknown>) {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()
  const encoder = new TextEncoder()
  const send = (value: Progress) => writer.write(encoder.encode(`${JSON.stringify(value)}\n`)).catch(() => {})
  const work = (async () => {
    try {
      const result = await run(send)
      await send({ type: 'complete', result })
    }
    catch (error) {
      await send({ type: 'error', message: errorMessage(error) })
    }
    finally {
      await writer.close().catch(() => {})
    }
  })()
  waitUntil(event, work)
  setResponseHeaders(event, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' })
  return readable
}
