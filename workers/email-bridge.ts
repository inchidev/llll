import { MAIL_LIMITS } from '../shared/mail'
import {
  configuredInboundSecret,
  copyBuffer,
  inboundWebhookShouldRetry,
  readLimitedStream,
  signInboundEmail,
} from './inbound-email-signature'

export type EmailBridgeMessage = {
  from: string
  to: string
  raw: ReadableStream<Uint8Array>
  rawSize?: number
  setReject(reason: string): void
}

export type EmailBridgeEnv = {
  LLLL_INBOUND_URL?: string
  INBOUND_EMAIL_SECRET?: string
}

/**
 * Forwards one Email Routing message to a self-hosted L4 inbound
 * webhook. Network errors and retryable statuses throw so Email Routing
 * retries. Other responses reject the message.
 */
export async function forwardInboundEmail(message: EmailBridgeMessage, env: EmailBridgeEnv, fetcher: typeof fetch = fetch): Promise<void> {
  const secret = configuredInboundSecret(env.INBOUND_EMAIL_SECRET)
  if (!secret) {
    message.setReject('Inbound email secret is not configured')
    return
  }
  const target = inboundUrl(env.LLLL_INBOUND_URL)
  if (!target) {
    message.setReject('Inbound URL is not configured')
    return
  }
  if ((message.rawSize ?? 0) > MAIL_LIMITS.rawBytes) {
    message.setReject('Message is too large')
    return
  }
  const body = await readLimitedStream(message.raw, MAIL_LIMITS.rawBytes)
  if (!body.ok) {
    message.setReject(body.reason === 'too-large' ? 'Message is too large' : 'Empty message')
    return
  }
  const from = message.from.trim()
  const to = message.to.trim()
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = await signInboundEmail(secret, timestamp, from, to, body.bytes)
  let response: Response
  try {
    response = await fetcher(target, {
      method: 'POST',
      headers: {
        'content-type': 'message/rfc822',
        'x-llll-email-timestamp': timestamp,
        'x-llll-email-from': from,
        'x-llll-email-to': to,
        'x-llll-email-signature': signature,
      },
      body: copyBuffer(body.bytes),
    })
  }
  catch {
    throw new Error('Inbound webhook unreachable')
  }
  if (response.ok) return
  if (inboundWebhookShouldRetry(response.status)) throw new Error(`Inbound webhook returned ${response.status}`)
  message.setReject(`Inbound webhook rejected the message (${response.status})`)
}

function inboundUrl(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  if (!trimmed) return null
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return url.toString()
  }
  catch {
    return null
  }
}
