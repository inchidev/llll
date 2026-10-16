import {
  cloudflareAccountId,
  cloudflareApiToken,
  cloudflareErrorMessage,
  cloudflareRestConfigured,
  emailSendUrl,
} from './cloudflare-rest'
import type { L4Env } from './env'

export type WorkspaceEmailAddress = string | { email: string, name: string }

export type WorkspaceEmailMessage = {
  from: WorkspaceEmailAddress
  to: WorkspaceEmailAddress | WorkspaceEmailAddress[]
  cc?: WorkspaceEmailAddress | WorkspaceEmailAddress[]
  bcc?: WorkspaceEmailAddress | WorkspaceEmailAddress[]
  replyTo?: WorkspaceEmailAddress
  subject: string
  text?: string
  html?: string
  headers?: Record<string, string>
}

type MailGatewayResponse = {
  messageId?: string
  error?: string
}

function httpUrl(value: string | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.toString()
  }
  catch {
    return null
  }
}

function mailGatewayFetcher(env: L4Env): { fetch: (request: Request) => Promise<Response> } | null {
  const gateway = env.MAIL_GATEWAY
  if (gateway && typeof gateway === 'object' && typeof gateway.fetch === 'function') return gateway
  return null
}

/** Service-binding URL, then `MAIL_GATEWAY_URL`, then a string `MAIL_GATEWAY`. */
export function mailGatewayHttpUrl(env: L4Env): string | null {
  return httpUrl(env.MAIL_GATEWAY_URL) || httpUrl(typeof env.MAIL_GATEWAY === 'string' ? env.MAIL_GATEWAY : undefined)
}

export function smtpGatewayHttpUrl(env: L4Env): string | null {
  return httpUrl(env.SMTP_GATEWAY_URL)
}

export type EmailProviderName = 'binding' | 'cloudflare-rest' | 'gateway' | 'smtp' | null

function gatewayConfigured(env: L4Env): boolean {
  if (mailGatewayFetcher(env) && env.MAIL_GATEWAY_TOKEN) return true
  if (mailGatewayHttpUrl(env) && env.MAIL_GATEWAY_TOKEN) return true
  return false
}

function smtpConfigured(env: L4Env): boolean {
  return Boolean(smtpGatewayHttpUrl(env) && env.SMTP_GATEWAY_TOKEN)
}

/** Binding, then Cloudflare Email Sending, then an HTTP gateway, then an SMTP gateway. */
export function emailProvider(env: L4Env): EmailProviderName {
  if (env.EMAIL || env.MAIL_EMAIL) return 'binding'
  if (cloudflareRestConfigured(env)) return 'cloudflare-rest'
  if (gatewayConfigured(env)) return 'gateway'
  if (smtpConfigured(env)) return 'smtp'
  return null
}

export function workspaceEmailAvailable(env: L4Env): boolean {
  if (env.MAIL_EMAIL) return true
  if (cloudflareRestConfigured(env)) return true
  if (gatewayConfigured(env)) return true
  if (smtpConfigured(env)) return true
  return false
}

export function authEmailAvailable(env: L4Env): boolean {
  return emailProvider(env) !== null
}

async function postJsonGateway(url: string, token: string, message: WorkspaceEmailMessage, label: string): Promise<{ messageId: string }> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    })
  }
  catch {
    throw new Error(`${label} did not respond`)
  }
  const payload = await response.json().catch(() => null) as MailGatewayResponse | null
  if (!response.ok || !payload?.messageId) {
    throw new Error(payload?.error || `${label} rejected the message (${response.status})`)
  }
  return { messageId: payload.messageId }
}

function emailApiBody(message: WorkspaceEmailMessage) {
  return {
    from: message.from,
    to: message.to,
    ...(message.cc ? { cc: message.cc } : {}),
    ...(message.bcc ? { bcc: message.bcc } : {}),
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    subject: message.subject,
    ...(message.text !== undefined ? { text: message.text } : {}),
    ...(message.html !== undefined ? { html: message.html } : {}),
  }
}

function emailMessageId(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null
  const record = result as Record<string, unknown>
  for (const key of ['message_id', 'messageId', 'id']) {
    if (typeof record[key] === 'string' && record[key]) return record[key] as string
  }
  const delivered = Array.isArray(record.delivered) ? record.delivered : []
  const queued = Array.isArray(record.queued) ? record.queued : []
  const address = [...delivered, ...queued].find((item): item is string => typeof item === 'string' && item.length > 0)
  if (address) return `cloudflare:${address}`
  if ('delivered' in record || 'queued' in record) return 'cloudflare:sent'
  return null
}

async function sendCloudflareEmail(env: L4Env, message: WorkspaceEmailMessage): Promise<{ messageId: string }> {
  const accountId = cloudflareAccountId(env)
  const token = cloudflareApiToken(env)
  if (!accountId || !token) throw new Error('Cloudflare API credentials are missing')
  let response: Response
  try {
    response = await fetch(emailSendUrl(accountId), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(emailApiBody(message)),
    })
  }
  catch {
    throw new Error('Cloudflare Email Sending did not respond')
  }
  const payload = await response.json().catch(() => null) as { success?: boolean, result?: unknown } | null
  const messageId = payload?.success !== false ? emailMessageId(payload?.result) : null
  if (!response.ok || payload?.success === false || !messageId) {
    throw new Error(cloudflareErrorMessage(payload, response.status, 'Cloudflare Email Sending'))
  }
  return { messageId }
}

export async function sendWorkspaceEmail(env: L4Env, message: WorkspaceEmailMessage): Promise<{ messageId: string }> {
  if (env.MAIL_EMAIL) return env.MAIL_EMAIL.send(message)
  if (cloudflareRestConfigured(env)) return sendCloudflareEmail(env, message)
  const fetcher = mailGatewayFetcher(env)
  if (fetcher && env.MAIL_GATEWAY_TOKEN) {
    const response = await fetcher.fetch(new Request('https://llll-primary.internal/.llll/mail/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.MAIL_GATEWAY_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    }))
    const payload = await response.json().catch(() => null) as MailGatewayResponse | null
    if (!response.ok || !payload?.messageId) {
      throw new Error(payload?.error || `Primary workspace mail rejected the message (${response.status})`)
    }
    return { messageId: payload.messageId }
  }
  const gatewayUrl = mailGatewayHttpUrl(env)
  if (gatewayUrl && env.MAIL_GATEWAY_TOKEN) {
    return postJsonGateway(gatewayUrl, env.MAIL_GATEWAY_TOKEN, message, 'Mail gateway')
  }
  const smtpUrl = smtpGatewayHttpUrl(env)
  if (smtpUrl && env.SMTP_GATEWAY_TOKEN) {
    return postJsonGateway(smtpUrl, env.SMTP_GATEWAY_TOKEN, message, 'SMTP gateway')
  }
  throw new Error('Workspace email sending is not configured')
}

export async function sendAuthEmail(env: L4Env, message: WorkspaceEmailMessage): Promise<{ messageId: string }> {
  if (env.EMAIL) return env.EMAIL.send(message)
  return sendWorkspaceEmail(env, message)
}
