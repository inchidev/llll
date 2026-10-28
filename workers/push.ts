import { buildPushPayload } from '@block65/webcrypto-web-push'
import type { PushNotificationPayload } from '../shared/notifications'
import { pushDeliveryDisposition, pushRetryDelayMs } from '../shared/notifications'
import type { L4Env } from './env'
import { Permission } from '../shared/permissions'

function isLiveTag(tag: string): boolean {
  return tag.startsWith('live:')
}

const DELIVERY_LIMIT = 20
const MAX_ATTEMPTS = 6
const LEASE_MS = 30_000
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

type OutboxRow = {
  event_id: string
  subscription_id: string
  payload_json: string
  attempts: number
  channel_id: string
  recipient_id: string
  kind: string
  endpoint: string
  p256dh: string
  auth: string
}

type BuiltPushRequest = Awaited<ReturnType<typeof buildPushPayload>>

export function workerPushRequestInit(request: BuiltPushRequest) {
  const headers = new Headers(request.headers)
  headers.delete('content-length')
  return { ...request, headers, redirect: 'manual' as const }
}

export function pushConfigured(env: L4Env): boolean {
  return Boolean(env.VAPID_SUBJECT?.trim() && env.VAPID_PUBLIC_KEY?.trim() && env.VAPID_PRIVATE_KEY?.trim())
}

/** Queued private-channel notifications do not retain a grant after membership removal. */
export async function privatePushAccessAllowed(db: D1Database, channelId: string, userId: string): Promise<boolean> {
  return Boolean(await db.prepare(`SELECT u.id FROM users u JOIN channels c ON c.id=?
    LEFT JOIN channels parent ON parent.id=c.parent_id
    WHERE u.id=? AND u.status='active' AND
    (COALESCE(parent.visibility,c.visibility)<>'private' OR EXISTS(
      SELECT 1 FROM channel_members cm WHERE cm.channel_id=COALESCE(parent.id,c.id) AND cm.user_id=u.id))`)
    .bind(channelId, userId).first())
}

/** A queued email push needs the recipient's mailbox grant and email permission at delivery time. */
export async function mailPushAccessAllowed(db: D1Database, threadId: string, userId: string): Promise<boolean> {
  return Boolean(await db.prepare(`SELECT 1 AS allowed FROM email_threads t
    JOIN email_mailbox_access a ON a.channel_id = t.mailbox_channel_id AND a.user_id = ?
    JOIN users u ON u.id = a.user_id AND u.status = 'active'
    JOIN roles r ON r.id = u.role_id CROSS JOIN server s
    WHERE t.channel_id = ? AND (u.id = s.owner_id OR (r.permissions_bitmask & ?) != 0)`)
    .bind(userId, threadId, Permission.readMail | Permission.sendMail).first())
}

async function deliverPush(env: L4Env, row: OutboxRow) {
  if (!await privatePushAccessAllowed(env.DB, row.channel_id, row.recipient_id)) return { disposition: 'failed' as const, error: 'access_revoked' }
  if (row.kind === 'mail' && !await mailPushAccessAllowed(env.DB, row.channel_id, row.recipient_id)) return { disposition: 'failed' as const, error: 'access_revoked' }
  if (!pushConfigured(env)) return { disposition: 'retry' as const, error: 'vapid_unconfigured' }
  let payload: PushNotificationPayload
  try {
    payload = JSON.parse(row.payload_json) as PushNotificationPayload
  }
  catch {
    return { disposition: 'failed' as const, error: 'invalid_payload' }
  }

  let request: BuiltPushRequest
  try {
    request = await buildPushPayload({
      data: payload,
      options: {
        ttl: isLiveTag(payload.tag) ? 90 : 4 * 60 * 60,
        urgency: isLiveTag(payload.tag) ? 'high' : 'normal',
      },
    }, {
      endpoint: row.endpoint,
      expirationTime: null,
      keys: { p256dh: row.p256dh, auth: row.auth },
    }, {
      subject: env.VAPID_SUBJECT!.trim(),
      publicKey: env.VAPID_PUBLIC_KEY!.trim(),
      privateKey: env.VAPID_PRIVATE_KEY!.trim(),
    })
  }
  catch (error) {
    return { disposition: 'retry' as const, error: pushErrorCode('build', error) }
  }

  try {
    const response = await fetch(row.endpoint, {
      ...workerPushRequestInit(request),
      signal: AbortSignal.timeout(10_000),
    })
    return { disposition: pushDeliveryDisposition(response.status), error: `http_${response.status}` }
  }
  catch (error) {
    return { disposition: 'retry' as const, error: pushErrorCode('fetch', error, row.endpoint) }
  }
}

function pushErrorCode(stage: 'build' | 'fetch', error: unknown, endpoint?: string): string {
  const name = error instanceof Error ? error.name : 'unknown'
  const safeName = name.toLowerCase().replace(/[^a-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '') || 'unknown'
  if (!(error instanceof Error) || !error.message) return `${stage}_${safeName}`
  const message = endpoint ? error.message.replaceAll(endpoint, '[endpoint]') : error.message
  const safeMessage = message
    .replace(/[A-Za-z0-9_-]{40,}/gu, '[token]')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, 120)
  return safeMessage ? `${stage}_${safeName}_${safeMessage}` : `${stage}_${safeName}`
}

export async function drainNotificationOutbox(env: L4Env): Promise<void> {
  const now = new Date()
  const nowIso = now.toISOString()
  const rows = await env.DB.prepare(
    `SELECT o.event_id, o.subscription_id, o.payload_json, o.attempts, o.channel_id, o.recipient_id, o.kind,
            s.endpoint, s.p256dh, s.auth
     FROM notification_outbox o
     JOIN push_subscriptions s ON s.id = o.subscription_id
     WHERE o.delivered_at IS NULL AND o.failed_at IS NULL
       AND o.available_at <= ?
       AND (o.lease_until IS NULL OR o.lease_until <= ?)
     ORDER BY o.available_at, o.created_at
     LIMIT ?`,
  ).bind(nowIso, nowIso, DELIVERY_LIMIT).all<OutboxRow>()

  for (const row of rows.results ?? []) {
    const leaseToken = crypto.randomUUID()
    const leaseUntil = new Date(Date.now() + LEASE_MS).toISOString()
    const claim = await env.DB.prepare(
      `UPDATE notification_outbox
       SET lease_token = ?, lease_until = ?, attempts = attempts + 1
       WHERE event_id = ? AND subscription_id = ?
         AND delivered_at IS NULL AND failed_at IS NULL
         AND (lease_until IS NULL OR lease_until <= ?)`,
    ).bind(leaseToken, leaseUntil, row.event_id, row.subscription_id, nowIso).run()
    if (!claim.meta.changes) continue

    const attempt = row.attempts + 1
    const result = await deliverPush(env, row)
    if (result.disposition === 'delivered') {
      await env.DB.prepare(
        `UPDATE notification_outbox
         SET delivered_at = ?, lease_token = NULL, lease_until = NULL, last_error = NULL
         WHERE event_id = ? AND subscription_id = ? AND lease_token = ?`,
      ).bind(new Date().toISOString(), row.event_id, row.subscription_id, leaseToken).run()
      continue
    }
    if (result.disposition === 'expired') {
      await env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(row.subscription_id).run()
      continue
    }
    if (result.disposition === 'failed' || attempt >= MAX_ATTEMPTS) {
      await env.DB.prepare(
        `UPDATE notification_outbox
         SET failed_at = ?, lease_token = NULL, lease_until = NULL, last_error = ?
         WHERE event_id = ? AND subscription_id = ? AND lease_token = ?`,
      ).bind(new Date().toISOString(), result.error, row.event_id, row.subscription_id, leaseToken).run()
      continue
    }
    const availableAt = new Date(Date.now() + pushRetryDelayMs(attempt)).toISOString()
    await env.DB.prepare(
      `UPDATE notification_outbox
       SET available_at = ?, lease_token = NULL, lease_until = NULL, last_error = ?
       WHERE event_id = ? AND subscription_id = ? AND lease_token = ?`,
    ).bind(availableAt, result.error, row.event_id, row.subscription_id, leaseToken).run()
  }

  await env.DB.prepare(
    `DELETE FROM notification_outbox
     WHERE COALESCE(delivered_at, failed_at) IS NOT NULL
       AND COALESCE(delivered_at, failed_at) < ?`,
  ).bind(new Date(Date.now() - TERMINAL_RETENTION_MS).toISOString()).run()
}

export async function nextNotificationDueAt(env: L4Env): Promise<number | null> {
  const row = await env.DB.prepare(
    `SELECT MIN(
       CASE
         WHEN lease_until IS NOT NULL AND lease_until > available_at THEN lease_until
         ELSE available_at
       END
     ) AS due_at
     FROM notification_outbox
     WHERE delivered_at IS NULL AND failed_at IS NULL`,
  ).first<{ due_at: string | null }>()
  if (!row?.due_at) return null
  const timestamp = Date.parse(row.due_at)
  return Number.isFinite(timestamp) ? timestamp : Date.now() + 60_000
}
