import { getServerId } from '../../../shared/server-id'
import { z } from 'zod'
import { newId, nowIso } from '../../../shared/ids'
import { embedOrigins } from '../../../shared/embed'
import { TELEGRAM_ENDPOINT_PREFIX } from '../../../shared/telegram-relay'
import { requireMember } from '../../utils/guards'
import { cf, fail } from '../../utils/cf'
import { parseBody } from '../../utils/validate'

const bodySchema = z.object({
  token: z.string().min(16).max(256).regex(/^[A-Za-z0-9_-]+$/u),
  relayOrigin: z.string().max(2048),
}).strict()

async function tokenKey(token: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))
  return TELEGRAM_ENDPOINT_PREFIX + [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Save a Telegram delivery token the Shell got for this Server. Only a Shell this Server
 * already allows to embed it can be its relay, so the token is never sent anywhere else.
 */
export default defineEventHandler(async (event) => {
  const member = await requireMember(event, (await getServerId(cf(event).env.DB)))
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  if (!embedOrigins(env.EMBED_ORIGINS).includes(body.relayOrigin)) fail(400, 'bad_request', 'This Shell cannot deliver notifications for this Server')
  const endpoint = await tokenKey(body.token)
  const now = nowIso()
  const existing = await env.DB.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).first<{ id: string }>()
  if (existing) {
    // The token belongs to one Telegram chat; whoever enabled it last on this Server receives it.
    await env.DB.prepare('UPDATE push_subscriptions SET user_id = ?, relay_origin = ?, relay_token = ?, updated_at = ? WHERE id = ?')
      .bind(member.user.id, body.relayOrigin, body.token, now, existing.id).run()
    return { subscribed: true }
  }
  const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM push_subscriptions WHERE user_id = ?').bind(member.user.id).first<{ count: number }>()
  if ((count?.count ?? 0) >= 8) fail(409, 'subscription_limit', 'Too many notification subscriptions')
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, created_at, updated_at, transport, relay_origin, relay_token)
     VALUES (?, ?, ?, '', '', ?, ?, ?, 'telegram', ?, ?)`,
  ).bind(newId(), member.user.id, endpoint, getHeader(event, 'user-agent')?.slice(0, 500) ?? null, now, now, body.relayOrigin, body.token).run()
  return { subscribed: true }
})
