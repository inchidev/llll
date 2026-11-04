/**
 * Cloudflare REST credentials for a Worker that is not running inside Cloudflare.
 * A binding still wins. These values are only used when that binding is absent.
 */

const ACCOUNT_ID = /^[0-9a-f]{32}$/i
const MIN_TOKEN_LENGTH = 32
export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4'

export type CloudflareRestEnv = {
  CLOUDFLARE_ACCOUNT_ID?: string
  CLOUDFLARE_API_TOKEN?: string
}

export function cloudflareAccountId(env: CloudflareRestEnv): string | null {
  const id = env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? ''
  return ACCOUNT_ID.test(id) ? id : null
}

export function cloudflareApiToken(env: CloudflareRestEnv): string | null {
  const token = env.CLOUDFLARE_API_TOKEN?.trim() ?? ''
  return token.length >= MIN_TOKEN_LENGTH ? token : null
}

/** Both values must be real enough to call the API. Placeholders such as `invalid` do not. */
export function cloudflareRestConfigured(env: CloudflareRestEnv): boolean {
  return Boolean(cloudflareAccountId(env) && cloudflareApiToken(env))
}

/** Model ids stay readable. `@cf/author/name` is not percent-encoded. */
export function workersAiRunUrl(accountId: string, model: string): string {
  if (!/^@?[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(model)) {
    throw new Error('Workers AI model id is not a path')
  }
  return `${CLOUDFLARE_API}/accounts/${accountId}/ai/run/${model}`
}

export function browserRunUrl(accountId: string, action: 'markdown' | 'links' | 'screenshot'): string {
  return `${CLOUDFLARE_API}/accounts/${accountId}/browser-run/${action}`
}

export function emailSendUrl(accountId: string): string {
  return `${CLOUDFLARE_API}/accounts/${accountId}/email/sending/send`
}

export function cloudflareErrorMessage(payload: unknown, status: number, label: string): string {
  if (payload && typeof payload === 'object') {
    const record = payload as { errors?: Array<{ message?: string }>, error?: string, message?: string }
    const message = record.errors?.find(item => item?.message)?.message || record.error || record.message
    if (message) return message
  }
  return `${label} failed (${status})`
}

type BrowserAction = 'markdown' | 'screenshot' | 'links'

type BrowserBinding = {
  quickAction: (action: BrowserAction, options: { url: string }) => Promise<Response>
}

/**
 * Browser Run quick actions over REST. Markdown and links come back as `{ result }`,
 * matching the Workers binding. Screenshots stay image bytes.
 */
export function cloudflareBrowser(env: CloudflareRestEnv): BrowserBinding {
  const accountId = cloudflareAccountId(env)
  const token = cloudflareApiToken(env)
  if (!accountId || !token) throw new Error('Cloudflare API credentials are missing')
  return {
    async quickAction(action, options) {
      let response: Response
      try {
        response = await fetch(browserRunUrl(accountId, action), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ url: options.url }),
        })
      }
      catch {
        return Response.json({ error: 'Cloudflare Browser Run did not respond' }, { status: 502 })
      }
      if (action === 'screenshot') return response
      const payload = await response.json().catch(() => null) as { success?: boolean, result?: unknown, errors?: unknown } | null
      if (!response.ok || payload?.success === false) {
        return Response.json(payload ?? { error: 'Browser request failed' }, { status: response.ok ? 502 : response.status })
      }
      const result = payload && typeof payload === 'object' && 'result' in payload ? payload.result : payload
      return Response.json({ result })
    },
  }
}
