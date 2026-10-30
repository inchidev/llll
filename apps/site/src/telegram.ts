import { z } from 'zod'
import { verifyMiniAppData } from '../../../shared/telegram'
import { TELEGRAM_RELAY_KINDS } from '../../../shared/telegram-relay'
import { uuidSchema } from '../../../shared/embed'
import { digest } from './session'
import type { WebEnv } from './env'

/**
 * Telegram notifications relay. A Server opened in the Telegram Shell gets an
 * opaque delivery token for one Telegram chat and its own Server ID. The relay
 * keeps no table of subscriptions: the token is all it needs, the Server never
 * learns the Telegram ID, and messages carry no conversation content.
 */

const relayToken = z.object({ v: z.literal(1), c: z.number().int().positive(), s: uuidSchema })
const encoder = new TextEncoder()

async function relayKeys(env: WebEnv) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(env.AUTH_SECRET), 'HKDF', false, ['deriveKey'])
  const hkdf = (info: string) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: encoder.encode(info) })
  return {
    cipher: await crypto.subtle.deriveKey(hkdf('llll-telegram-relay-v1-cipher'), material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
    nonce: await crypto.subtle.deriveKey(hkdf('llll-telegram-relay-v1-nonce'), material, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']),
  }
}
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
const fromBase64url = (value: string) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0))

/** Deterministic per chat and Server, so enabling twice yields the same subscription. */
export async function createRelayToken(env: WebEnv, chatId: number, serverId: string) {
  const keys = await relayKeys(env)
  const plain = encoder.encode(JSON.stringify({ v: 1, c: chatId, s: serverId }))
  const iv = new Uint8Array(await crypto.subtle.sign('HMAC', keys.nonce, plain)).slice(0, 12)
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, keys.cipher, plain))
  const token = new Uint8Array(iv.length + sealed.length); token.set(iv); token.set(sealed, iv.length)
  return base64url(token)
}

export async function openRelayToken(env: WebEnv, token: string) {
  try {
    const bytes = fromBase64url(token)
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, (await relayKeys(env)).cipher, bytes.slice(12))
    return relayToken.parse(JSON.parse(new TextDecoder().decode(plain)))
  } catch { return null }
}

const subscribeBody = z.object({ initData: z.string().min(1).max(16000), serverId: uuidSchema }).strict()
const notifyBody = z.object({
  token: z.string().min(16).max(256).regex(/^[A-Za-z0-9_-]+$/u),
  serverId: uuidSchema,
  serverName: z.string().trim().min(1).max(100),
  kind: z.enum(TELEGRAM_RELAY_KINDS),
  path: z.string().max(2000).regex(/^\/(?!\/)[^\s\\]*$/u).default('/'),
  // Opaque per outbox delivery, so a retry after a lost answer does not send the message twice.
  delivery: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
}).strict()

const relayText: Record<(typeof TELEGRAM_RELAY_KINDS)[number], string> = {
  mention: 'You were mentioned',
  dm_message: 'New direct message',
  live_started: 'A Live session started',
  mail: 'New email',
}

type Fail = (status: number, message: string) => never

/** Launch data stays valid for an hour here: people enable notifications after browsing for a while. */
export async function subscribeTelegram(env: WebEnv, value: unknown, fail: Fail) {
  if (!env.TELEGRAM_BOT_TOKEN) fail(503, 'Telegram notifications are not configured')
  const body = subscribeBody.parse(value)
  let user
  try { user = await verifyMiniAppData(body.initData, env.TELEGRAM_BOT_TOKEN!, Date.now(), 3600) }
  catch { fail(401, 'Reopen L4 in Telegram and try again') }
  return { token: await createRelayToken(env, user!.id, body.serverId) }
}

export async function relayTelegram(env: WebEnv, value: unknown, fail: Fail) {
  if (!env.TELEGRAM_BOT_TOKEN) fail(503, 'Telegram notifications are not configured')
  const body = notifyBody.parse(value)
  const target = await openRelayToken(env, body.token)
  // 410 tells the Server to drop the subscription, like an expired Web Push endpoint.
  if (!target || target.s !== body.serverId) fail(410, 'Unknown Telegram subscription')
  const sent = body.delivery ? await digest('telegram-sent:' + body.token + ':' + body.delivery) : null
  if (sent) {
    const claim = await env.DB.prepare('INSERT INTO rate_limits(key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=1, expires_at=excluded.expires_at WHERE rate_limits.expires_at < ? RETURNING count')
      .bind(sent, Date.now() + 86400000, Date.now()).first<{ count: number }>()
    if (!claim) return { delivered: true }
  }
  // Let the Server retry a delivery that never reached Telegram.
  const release = async () => { if (sent) await env.DB.prepare('DELETE FROM rate_limits WHERE key = ?').bind(sent).run() }
  const key = await digest('telegram:' + body.token + ':' + Math.floor(Date.now() / 60000))
  const row = await env.DB.prepare('INSERT INTO rate_limits(key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count').bind(key, Date.now() + 120000).first<{ count: number }>()
  if ((row?.count || 0) > 30) { await release(); fail(429, 'Too many notifications. Try again shortly.') }
  // A timeout may still have reached Telegram, so only a refusal releases the claim.
  const open = new URL('/' + body.serverId + (body.path === '/' ? '' : body.path), env.PUBLIC_ORIGIN).toString()
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(10000),
    body: JSON.stringify({
      chat_id: target!.c,
      text: `${relayText[body.kind]} on ${body.serverName}`,
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [[{ text: 'Open', web_app: { url: open } }]] },
    }),
  })
  if (response.ok) return { delivered: true }
  await release()
  const description = String((await response.json().catch(() => null) as { description?: unknown } | null)?.description || '')
  // Blocked bot, deleted account or a chat that never allowed messages: the subscription is gone.
  if (response.status === 403 || (response.status === 400 && /chat not found/iu.test(description))) fail(410, 'Telegram no longer accepts messages for this subscription')
  if (response.status === 429) fail(429, 'Telegram is rate limiting messages')
  fail(502, 'Telegram did not accept the message')
}
