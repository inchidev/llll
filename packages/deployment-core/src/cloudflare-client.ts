import Cloudflare from 'cloudflare'
import { InstallerError } from './errors.js'

export function cloudflareClient(accessToken: string) {
  return new Cloudflare({ apiToken: accessToken })
}

type ApiEnvelope<T> = {
  success?: boolean
  result?: T
  errors?: Array<{ message?: string }>
  messages?: Array<{ message?: string }>
}

class CloudflareApiError extends InstallerError {
  readonly retryAfter: string | null
  readonly retryAllowed: boolean

  constructor(status: number, message: string, headers: Headers) {
    super(status, message)
    this.retryAfter = headers.get('retry-after')
    this.retryAllowed = headers.get('x-should-retry') !== 'false'
  }
}

/** Opt-in only: callers must reconcile state before replaying a write. */
export function cloudflareRetryDelay(error: unknown, retry: number): number | null {
  if (!(error instanceof CloudflareApiError)
    || ![408, 429, 500, 502, 503, 504].includes(error.statusCode)
    || !error.retryAllowed) return null
  const header = error.retryAfter
  let retryAfter = 0
  if (header) {
    const seconds = Number(header)
    retryAfter = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(header) - Date.now())
    if (!Number.isFinite(retryAfter)) retryAfter = 0
  }
  // Do not retry earlier than requested, or hold a deployment indefinitely.
  if (retryAfter > 30_000) return null
  return Math.max(retryAfter, Math.round(1000 * 2 ** retry * (1 + Math.random() * 0.25)))
}

export async function cloudflareApi<T>(
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${accessToken}`)
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, { ...init, headers })
  const contentType = response.headers.get('content-type') || ''
  const payload = contentType.includes('application/json')
    ? await response.json() as ApiEnvelope<T>
    : await response.text()

  if (!response.ok || (typeof payload === 'object' && payload && payload.success === false)) {
    const message = typeof payload === 'object' && payload
      ? payload.errors?.[0]?.message || payload.messages?.[0]?.message
      : String(payload)
    // A failure envelope with HTTP 200 is not a transient HTTP failure.
    if (response.status < 400) throw new InstallerError(502, message || 'Cloudflare API operation failed')
    throw new CloudflareApiError(response.status, message || `Cloudflare API request failed (${response.status})`, response.headers)
  }

  if (typeof payload === 'object' && payload && 'result' in payload) return payload.result as T
  return payload as T
}

export function publicErrorMessage(error: unknown) {
  if (error && typeof error === 'object') {
    const candidate = error as { statusMessage?: unknown, message?: unknown }
    if (typeof candidate.statusMessage === 'string') return candidate.statusMessage
    if (typeof candidate.message === 'string') return candidate.message
  }
  return 'Cloudflare deployment failed'
}
