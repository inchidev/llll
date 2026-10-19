import { MAIL_LIMITS } from '../shared/mail'
import { cloudflareNetwork, type L4Env } from './env'
import {
  configuredInboundSecret,
  INBOUND_EMAIL_REPLAY_SECONDS,
  inboundTimestampFresh,
  readLimitedStream,
  verifyInboundEmailSignature,
  verifyMailgunSignature,
} from './inbound-email-signature'
import { ingestServerEmail, type ServerEmailIngressResult } from './mail-ingress'
import { secureTokenEqual } from './mail-gateway-ingress'
import { allowedSnsSubscribeUrl, verifySnsMessage, type SnsMessage } from './sns-signature'

/**
 * Which inbound path health reports. On Cloudflare's network the `email()`
 * handler is `binding`. Elsewhere the first configured webhook wins. Every
 * configured endpoint still accepts mail.
 */
export type EmailInboundProvider = 'binding' | 'bridge' | 'postmark' | 'mailgun' | 'ses' | null

const SES_TOPIC_ARN = /^arn:aws:sns:[a-z0-9-]+:\d{12}:[\w-]+$/
const RECIPIENT = /^[^\s@]+@[^\s@]+$/
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function configuredSesTopicArn(value: string | undefined): string | null {
  const arn = value?.trim() ?? ''
  return SES_TOPIC_ARN.test(arn) ? arn : null
}

export function emailInboundProvider(env: L4Env): EmailInboundProvider {
  if (cloudflareNetwork(env)) return 'binding'
  if (configuredInboundSecret(env.INBOUND_EMAIL_SECRET)) return 'bridge'
  if (configuredInboundSecret(env.POSTMARK_INBOUND_SECRET)) return 'postmark'
  if (configuredInboundSecret(env.MAILGUN_WEBHOOK_SIGNING_KEY)) return 'mailgun'
  if (configuredSesTopicArn(env.SES_SNS_TOPIC_ARN)) return 'ses'
  return null
}

/** JSON wrappers are larger than the RFC822 they carry. Base64 is 4/3. */
function wrappedLimit(): number {
  return Math.ceil(MAIL_LIMITS.rawBytes * 4 / 3) + 256 * 1024
}

function unauthorized(): Response {
  return new Response('Unauthorized', { status: 401 })
}

function badRequest(message: string): Response {
  return new Response(message, { status: 400 })
}

function tooLarge(): Response {
  return new Response('Message is too large', { status: 413 })
}

function statusForReason(reason: string): number {
  if (reason === 'Unknown L4 mailbox') return 404
  if (reason === 'Message is too large') return 413
  return 422
}

function rawStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

async function deliver(env: L4Env, from: string, recipients: string[], raw: Uint8Array, successStatus: 200 | 202): Promise<Response> {
  if (!recipients.length) return badRequest('Missing recipient')
  let accepted = false
  let failure = 422
  let failureBody = 'Rejected'
  for (const to of recipients) {
    let result: ServerEmailIngressResult
    try {
      result = await ingestServerEmail({ from, to, raw: rawStream(raw), rawSize: raw.byteLength }, env)
    }
    catch {
      return new Response('Inbound email failed', { status: 500 })
    }
    if (result.accepted) {
      accepted = true
      continue
    }
    failure = statusForReason(result.reason)
    failureBody = result.reason
  }
  if (accepted) return new Response(null, { status: successStatus })
  return new Response(failureBody, { status: failure })
}

function envelopeField(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length > 320 || /[\r\n]/.test(trimmed)) return null
  return trimmed
}

function recipientField(value: string): string | null {
  const trimmed = envelopeField(value)
  if (!trimmed || !RECIPIENT.test(trimmed)) return null
  return trimmed
}

function extractAddress(value: string): string {
  const wrapped = /<([^<>\s]+)>/.exec(value)
  return (wrapped?.[1] ?? value).trim()
}

function decodeBase64(value: string, maxDecoded = MAIL_LIMITS.rawBytes): Uint8Array | null {
  const cleaned = value.replace(/\s+/g, '')
  if (!cleaned || cleaned.length % 4 === 1) return null
  if (cleaned.length > Math.ceil(maxDecoded / 3) * 4 + 8) return null
  try {
    const binary = atob(cleaned)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  }
  catch {
    return null
  }
}

function isJson(contentType: string): boolean {
  return contentType.split(';')[0]?.trim().toLowerCase() === 'application/json'
}

function basicPassword(header: string): string | null {
  const match = /^Basic\s+(\S+)$/i.exec(header.trim())
  if (!match?.[1]) return null
  const bytes = decodeBase64(match[1], 512)
  if (!bytes || bytes.byteLength > 512) return null
  const decoded = decoder.decode(bytes)
  const colon = decoded.indexOf(':')
  if (colon < 0) return null
  return decoded.slice(colon + 1)
}

/**
 * `POST /api/email/inbound`. HMAC-SHA256 over the timestamp, envelope, and raw
 * RFC822 bytes, using `INBOUND_EMAIL_SECRET`. Unsigned requests are rejected.
 */
export async function acceptSignedInboundEmail(request: Request, env: L4Env): Promise<Response> {
  const secret = configuredInboundSecret(env.INBOUND_EMAIL_SECRET)
  if (!secret) return unauthorized()
  const json = isJson(request.headers.get('content-type') ?? '')
  const body = await readLimitedStream(request.body, json ? wrappedLimit() : MAIL_LIMITS.rawBytes)
  if (!body.ok) return body.reason === 'too-large' ? tooLarge() : badRequest('Empty message')

  const timestamp = request.headers.get('x-llll-email-timestamp')?.trim() ?? ''
  const from = request.headers.get('x-llll-email-from')?.trim() ?? ''
  const to = request.headers.get('x-llll-email-to')?.trim() ?? ''
  const signature = request.headers.get('x-llll-email-signature')?.trim() ?? ''
  if (!inboundTimestampFresh(timestamp)) return unauthorized()

  let raw = body.bytes
  if (json) {
    const decoded = decodeSignedJson(body.bytes)
    if (decoded === 'invalid') return badRequest('Invalid JSON message')
    if (decoded === 'too-large') return tooLarge()
    raw = decoded
  }
  if (raw.byteLength > MAIL_LIMITS.rawBytes) return tooLarge()
  if (!await verifyInboundEmailSignature(secret, timestamp, from, to, raw, signature)) return unauthorized()
  const sender = from === '' ? '' : envelopeField(from)
  const recipient = recipientField(to)
  if (sender === null || !recipient || !raw.byteLength) return badRequest(raw.byteLength ? 'Invalid envelope' : 'Empty message')
  return deliver(env, sender, [recipient], raw, 202)
}

function decodeSignedJson(bytes: Uint8Array): Uint8Array | 'invalid' | 'too-large' {
  let parsed: unknown
  try {
    parsed = JSON.parse(decoder.decode(bytes))
  }
  catch {
    return 'invalid'
  }
  if (!parsed || typeof parsed !== 'object') return 'invalid'
  const record = parsed as { raw?: unknown, rawEncoding?: unknown }
  if (typeof record.raw !== 'string') return 'invalid'
  const encoding = record.rawEncoding ?? 'utf8'
  if (encoding === 'base64') {
    const cleanedLength = record.raw.replace(/\s+/g, '').length
    if (cleanedLength > Math.ceil(MAIL_LIMITS.rawBytes / 3) * 4 + 8) return 'too-large'
    const decoded = decodeBase64(record.raw)
    if (!decoded) return 'invalid'
    if (decoded.byteLength > MAIL_LIMITS.rawBytes) return 'too-large'
    return decoded
  }
  if (encoding !== 'utf8') return 'invalid'
  const decoded = encoder.encode(record.raw)
  if (decoded.byteLength > MAIL_LIMITS.rawBytes) return 'too-large'
  return decoded
}

type PostmarkAddress = { Email?: unknown }
type PostmarkPayload = {
  From?: unknown
  FromFull?: { Email?: unknown }
  To?: unknown
  ToFull?: unknown
  OriginalRecipient?: unknown
  RawEmail?: unknown
}

/**
 * `POST /api/email/inbound/postmark`. Postmark does not HMAC-sign inbound
 * webhooks. HTTP Basic auth is the check: any username, and the password must
 * equal `POSTMARK_INBOUND_SECRET`. `RawEmail` is the RFC822 message.
 */
export async function acceptPostmarkInbound(request: Request, env: L4Env): Promise<Response> {
  const secret = configuredInboundSecret(env.POSTMARK_INBOUND_SECRET)
  if (!secret) return unauthorized()
  const password = basicPassword(request.headers.get('authorization') ?? '')
  if (!password || !await secureTokenEqual(password, secret)) return unauthorized()
  const body = await readLimitedStream(request.body, wrappedLimit())
  if (!body.ok) return body.reason === 'too-large' ? tooLarge() : badRequest('Empty message')
  let parsed: PostmarkPayload
  try {
    parsed = JSON.parse(decoder.decode(body.bytes)) as PostmarkPayload
  }
  catch {
    return badRequest('Invalid JSON message')
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.RawEmail !== 'string') {
    return new Response('RawEmail is required', { status: 422 })
  }
  const raw = encoder.encode(parsed.RawEmail)
  if (raw.byteLength > MAIL_LIMITS.rawBytes) return tooLarge()
  if (!raw.byteLength) return badRequest('Empty message')
  const toFull = Array.isArray(parsed.ToFull) ? parsed.ToFull as PostmarkAddress[] : []
  const to = recipientField(text(parsed.OriginalRecipient) || text(toFull[0]?.Email) || text(parsed.To))
  const from = envelopeField(extractAddress(text(parsed.FromFull?.Email) || text(parsed.From)))
  if (!to || from === null) return badRequest('Invalid envelope')
  return deliver(env, from, [to], raw, 200)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function stringField(form: FormData, name: string): string {
  const value = form.get(name)
  return typeof value === 'string' ? value : ''
}

async function mimeBytes(value: FormDataEntryValue | null): Promise<Uint8Array | null> {
  if (typeof value === 'string') {
    if (!value) return null
    const bytes = encoder.encode(value)
    return bytes.byteLength ? bytes : null
  }
  if (value && typeof value.arrayBuffer === 'function') {
    const bytes = new Uint8Array(await value.arrayBuffer())
    return bytes.byteLength ? bytes : null
  }
  return null
}

/**
 * `POST /api/email/inbound/mailgun`. Mailgun signs `timestamp` concatenated
 * with `token` using the webhook signing key. The route URL must end in
 * `mime` so the form includes `body-mime`.
 */
export async function acceptMailgunInbound(request: Request, env: L4Env): Promise<Response> {
  const key = configuredInboundSecret(env.MAILGUN_WEBHOOK_SIGNING_KEY)
  if (!key) return unauthorized()
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > wrappedLimit()) return tooLarge()
  let form: FormData
  try {
    form = await request.formData()
  }
  catch {
    return badRequest('Invalid form body')
  }
  const timestamp = stringField(form, 'timestamp')
  const token = stringField(form, 'token')
  const signature = stringField(form, 'signature')
  if (!await verifyMailgunSignature(key, timestamp, token, signature)) return unauthorized()
  if (!inboundTimestampFresh(timestamp)) return unauthorized()
  const raw = await mimeBytes(form.get('body-mime'))
  if (!raw) return new Response('body-mime is required', { status: 422 })
  if (raw.byteLength > MAIL_LIMITS.rawBytes) return tooLarge()
  const to = recipientField(stringField(form, 'recipient'))
  const from = envelopeField(extractAddress(stringField(form, 'sender') || stringField(form, 'from')))
  if (!to || from === null) return badRequest('Invalid envelope')
  return deliver(env, from, [to], raw, 200)
}

type SesReceipt = {
  notificationType?: unknown
  mail?: { source?: unknown, destination?: unknown }
  receipt?: { recipients?: unknown }
  content?: unknown
}

/**
 * `POST /api/email/inbound/ses`. Verifies the Amazon SNS signature and
 * `SES_SNS_TOPIC_ARN`, confirms subscriptions, then stores each receipt
 * recipient through the same ingest path.
 */
export async function acceptSesInbound(request: Request, env: L4Env, fetcher: typeof fetch = fetch): Promise<Response> {
  const topic = configuredSesTopicArn(env.SES_SNS_TOPIC_ARN)
  if (!topic) return unauthorized()
  const body = await readLimitedStream(request.body, wrappedLimit())
  if (!body.ok) return body.reason === 'too-large' ? tooLarge() : badRequest('Empty message')
  let message: SnsMessage
  try {
    message = JSON.parse(decoder.decode(body.bytes)) as SnsMessage
  }
  catch {
    return badRequest('Invalid SNS message')
  }
  if (message.TopicArn !== topic) return unauthorized()
  if (!snsTimestampFresh(message.Timestamp)) return unauthorized()
  if (!await verifySnsMessage(message, fetcher)) return unauthorized()
  if (message.Type === 'SubscriptionConfirmation' || message.Type === 'UnsubscribeConfirmation') {
    return confirmSnsSubscription(message.SubscribeURL, fetcher)
  }
  if (message.Type !== 'Notification' || typeof message.Message !== 'string') return badRequest('Invalid SNS message')
  let receipt: SesReceipt
  try {
    receipt = JSON.parse(message.Message) as SesReceipt
  }
  catch {
    return badRequest('Invalid SES notification')
  }
  if (receipt.notificationType && receipt.notificationType !== 'Received') return new Response(null, { status: 200 })
  if (typeof receipt.content !== 'string') return new Response('SES content is required', { status: 422 })
  const raw = encoder.encode(receipt.content)
  if (raw.byteLength > MAIL_LIMITS.rawBytes) return tooLarge()
  if (!raw.byteLength) return badRequest('Empty message')
  const recipients = sesRecipients(receipt).map(recipientField).filter((value): value is string => Boolean(value))
  const from = envelopeField(extractAddress(text(receipt.mail?.source)))
  if (!recipients.length || from === null) return badRequest('Invalid envelope')
  return deliver(env, from, recipients, raw, 200)
}

function snsTimestampFresh(value: string | undefined): boolean {
  if (!value) return false
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return false
  return Math.abs(Date.now() - ms) <= INBOUND_EMAIL_REPLAY_SECONDS * 1000
}

function sesRecipients(receipt: SesReceipt): string[] {
  const fromReceipt = Array.isArray(receipt.receipt?.recipients) ? receipt.receipt.recipients : []
  const fromMail = Array.isArray(receipt.mail?.destination) ? receipt.mail.destination : []
  const source = fromReceipt.length ? fromReceipt : fromMail
  return source.filter((value): value is string => typeof value === 'string')
}

async function confirmSnsSubscription(subscribeUrl: string | undefined, fetcher: typeof fetch): Promise<Response> {
  const url = subscribeUrl ? allowedSnsSubscribeUrl(subscribeUrl) : null
  if (!url) return badRequest('Invalid SubscribeURL')
  try {
    const response = await fetcher(url, { redirect: 'error' })
    if (!response.ok) return new Response('Subscription confirmation failed', { status: 500 })
  }
  catch {
    return new Response('Subscription confirmation failed', { status: 500 })
  }
  return new Response(null, { status: 200 })
}
