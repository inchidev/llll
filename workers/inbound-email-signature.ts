import { secureTokenEqual } from './mail-gateway-ingress'

const encoder = new TextEncoder()

/** Signatures older or newer than this are rejected. */
export const INBOUND_EMAIL_REPLAY_SECONDS = 5 * 60

const MIN_SECRET_LENGTH = 32

export function configuredInboundSecret(value: string | undefined): string | null {
  const secret = value?.trim() ?? ''
  return secret.length >= MIN_SECRET_LENGTH ? secret : null
}

/** Unix seconds, close enough to now that a captured request cannot be replayed later. */
export function inboundTimestampFresh(timestamp: string, nowMs = Date.now(), windowSeconds = INBOUND_EMAIL_REPLAY_SECONDS): boolean {
  if (!/^\d{1,12}$/.test(timestamp)) return false
  const seconds = Number(timestamp)
  const now = Math.floor(nowMs / 1000)
  return Math.abs(now - seconds) <= windowSeconds
}

/**
 * Bytes covered by the inbound signature: timestamp, envelope sender, envelope
 * recipient, and the raw RFC822 message. The raw bytes are appended so a JSON
 * wrapper cannot change what was signed.
 */
export function inboundEmailSignedBytes(timestamp: string, from: string, to: string, raw: Uint8Array): Uint8Array {
  const prefix = encoder.encode(`${timestamp}.${from}.${to}.`)
  const bytes = new Uint8Array(prefix.byteLength + raw.byteLength)
  bytes.set(prefix, 0)
  bytes.set(raw, prefix.byteLength)
  return bytes
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** A fresh ArrayBuffer. WebCrypto rejects a Uint8Array view of a shared buffer. */
export function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}

export async function signInboundEmail(secret: string, timestamp: string, from: string, to: string, raw: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', key, copyBuffer(inboundEmailSignedBytes(timestamp, from, to, raw)))
  return hex(signature)
}

export async function verifyInboundEmailSignature(secret: string, timestamp: string, from: string, to: string, raw: Uint8Array, signature: string): Promise<boolean> {
  const expected = await signInboundEmail(secret, timestamp, from, to, raw)
  const presented = signature.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(presented)) return false
  return secureTokenEqual(expected, presented)
}

export async function verifyMailgunSignature(signingKey: string, timestamp: string, token: string, signature: string): Promise<boolean> {
  if (!/^\d{1,12}$/.test(timestamp) || !/^[A-Za-z0-9_-]{16,128}$/.test(token)) return false
  const presented = signature.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(presented)) return false
  const key = await crypto.subtle.importKey('raw', encoder.encode(signingKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signed = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}${token}`))
  return secureTokenEqual(hex(signed), presented)
}

/** Email Routing should retry these. Other failures are permanent. */
const RETRYABLE_INBOUND_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504])

export function inboundWebhookShouldRetry(status: number): boolean {
  return RETRYABLE_INBOUND_STATUS.has(status)
}

export type LimitedBody =
  | { ok: true, bytes: Uint8Array }
  | { ok: false, reason: 'too-large' | 'empty' }

/** Reads a body, stopping once it passes `limit`. */
export async function readLimitedStream(stream: ReadableStream<Uint8Array> | null, limit: number): Promise<LimitedBody> {
  if (!stream) return { ok: false, reason: 'empty' }
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value?.byteLength) continue
      size += value.byteLength
      if (size > limit) {
        await reader.cancel().catch(() => {})
        return { ok: false, reason: 'too-large' }
      }
      chunks.push(value)
    }
  }
  catch {
    await reader.cancel().catch(() => {})
    return { ok: false, reason: 'empty' }
  }
  if (!size) return { ok: false, reason: 'empty' }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { ok: true, bytes }
}
