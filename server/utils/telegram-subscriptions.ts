import { newId, nowIso } from '../../shared/ids'
import { embedOrigins } from '../../shared/embed'
import { sha256Hex } from '../../shared/server-settings'
import { TELEGRAM_ENDPOINT_PREFIX } from '../../shared/telegram-relay'
import type { L4Env } from '../../workers/env'
import { fail } from './cf'

/**
 * Save a Telegram delivery token for this Account. Only a Shell this Server already
 * allows to embed it can be its relay, so the token is never sent anywhere else.
 */
export async function saveTelegramSubscription(env: L4Env, userId: string, token: string, relayOrigin: string, userAgent: string | null) {
  if (!embedOrigins(env.EMBED_ORIGINS).includes(relayOrigin)) fail(400, 'bad_request', 'This Shell cannot deliver notifications for this Server')
  const endpoint = TELEGRAM_ENDPOINT_PREFIX + await sha256Hex(token)
  const now = nowIso()
  const existing = await env.DB.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).first<{ id: string }>()
  if (existing) {
    // The token belongs to one Telegram chat; whoever enabled it last on this Server receives it.
    await env.DB.prepare('UPDATE push_subscriptions SET user_id = ?, relay_origin = ?, relay_token = ?, updated_at = ? WHERE id = ?')
      .bind(userId, relayOrigin, token, now, existing.id).run()
    return
  }
  const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM push_subscriptions WHERE user_id = ?').bind(userId).first<{ count: number }>()
  if ((count?.count ?? 0) >= 8) fail(409, 'subscription_limit', 'Too many notification subscriptions')
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, created_at, updated_at, transport, relay_origin, relay_token)
     VALUES (?, ?, ?, '', '', ?, ?, ?, 'telegram', ?, ?)`,
  ).bind(newId(), userId, endpoint, userAgent?.slice(0, 500) ?? null, now, now, relayOrigin, token).run()
}

/** Pairing from a browser goes through the official Shell's relay. */
export function telegramLinkRelay(env: L4Env) {
  return embedOrigins(env.EMBED_ORIGINS)[0]!
}

/** Only this Server can derive it, and only for the Account that asked for the code. */
export async function telegramLinkSecret(env: L4Env, userId: string, code: string) {
  if (!env.AUTH_SECRET) fail(503, 'secret_unavailable', 'Server encryption is unavailable')
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.AUTH_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`llll-telegram-link-v1:${userId}:${code}`))
  return [...new Uint8Array(mac)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
