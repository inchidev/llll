import Cloudflare from 'cloudflare'
import { createError } from './errors.js'

export function cloudflareClient(accessToken: string) {
  return new Cloudflare({ apiToken: accessToken })
}

type ApiEnvelope<T> = {
  success?: boolean
  result?: T
  errors?: Array<{ message?: string }>
  messages?: Array<{ message?: string }>
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
    throw createError({
      statusCode: response.status >= 400 ? response.status : 502,
      statusMessage: message || `Cloudflare API request failed (${response.status})`,
    })
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
