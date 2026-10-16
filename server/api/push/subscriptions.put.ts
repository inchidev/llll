import { z } from 'zod'
import { WORKSPACE_ID, newId, nowIso } from '../../../shared/ids'
import { isBase64UrlKey, isSafePushEndpoint } from '../../../shared/notifications'
import { requireMember } from '../../utils/guards'
import { cf, fail } from '../../utils/cf'
import { parseBody } from '../../utils/validate'
import { pushConfigured } from '../../../workers/push'

const bodySchema = z.object({
  endpoint: z.string().max(4096),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().max(256),
    auth: z.string().max(128),
  }),
})

export default defineEventHandler(async (event) => {
  const member = await requireMember(event, WORKSPACE_ID)
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  if (!pushConfigured(env)) fail(503, 'push_unconfigured', 'Web Push is not configured')
  if (!isSafePushEndpoint(body.endpoint)
    || !isBase64UrlKey(body.keys.p256dh, 80, 128)
    || !isBase64UrlKey(body.keys.auth, 16, 64)) {
    fail(400, 'bad_request', 'Invalid push subscription')
  }

  const existing = await env.DB.prepare(
    'SELECT id, user_id FROM push_subscriptions WHERE endpoint = ?',
  ).bind(body.endpoint).first<{ id: string; user_id: string }>()
  if (existing && existing.user_id !== member.user.id) {
    fail(409, 'subscription_conflict', 'This browser subscription belongs to another account')
  }
  const now = nowIso()
  if (existing) {
    await env.DB.prepare(
      'UPDATE push_subscriptions SET p256dh = ?, auth = ?, user_agent = ?, updated_at = ? WHERE id = ? AND user_id = ?',
    ).bind(body.keys.p256dh, body.keys.auth, getHeader(event, 'user-agent')?.slice(0, 500) ?? null, now, existing.id, member.user.id).run()
    return { subscribed: true }
  }

  const count = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM push_subscriptions WHERE user_id = ?',
  ).bind(member.user.id).first<{ count: number }>()
  if ((count?.count ?? 0) >= 8) fail(409, 'subscription_limit', 'Too many notification subscriptions')
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    newId(),
    member.user.id,
    body.endpoint,
    body.keys.p256dh,
    body.keys.auth,
    getHeader(event, 'user-agent')?.slice(0, 500) ?? null,
    now,
    now,
  ).run()
  return { subscribed: true }
})
