import { mailDeliveryUncertain } from '../../../../../shared/mail'
import { z } from 'zod'
import type { MailMessageDTO } from '../../../../../shared/types'
import { requireMailboxPermission, requireMailSendLimit } from '../../../../utils/server-mail'
import { cf, fail } from '../../../../utils/cf'
import { parseBody } from '../../../../utils/validate'
import { loadMailMessage } from '../../../../utils/mail-data'
import { deliverOutboundEmail } from '../../../../utils/mail-outbound'
import { serverEmailAvailable } from '../../../../../workers/mail-transport'
import { signalMailChanged } from '../../../../../workers/mail-events'

const schema = z.object({ messageId: z.string().min(8).max(80), confirmUncertain: z.boolean().default(false) })

/** Tries again to deliver an email whose last attempt failed. */
export default defineEventHandler(async (event): Promise<{ message: MailMessageDTO }> => {
  const id = getRouterParam(event, 'id')!
  const access = await requireMailboxPermission(event, id, 'send')
  if (access.channel.type !== 'thread') fail(404, 'not_found', 'Email conversation not found')
  const body = parseBody(schema, await readBody(event))
  const { env, waitUntil } = cf(event)
  if (!serverEmailAvailable(env)) fail(503, 'mail_unavailable', 'Server email sending is not bound')
  const row = await env.DB.prepare(
    `SELECT delivery_status as deliveryStatus, delivery_attempts as deliveryAttempts, delivery_started_at as deliveryStartedAt, created_at as createdAt FROM email_messages
     WHERE message_id = ? AND thread_channel_id = ? AND direction = 'outbound'`,
  ).bind(body.messageId, id).first<{ deliveryStatus: string; deliveryAttempts: number; deliveryStartedAt: string | null; createdAt: string }>()
  if (!row) fail(404, 'not_found', 'Email not found')
  const uncertain = mailDeliveryUncertain(row)
  if (uncertain && !body.confirmUncertain) fail(409, 'delivery_uncertain', 'The recipient may already have this email. Confirm before sending another copy.')
  if (row.deliveryStatus !== 'failed' && !uncertain) fail(409, 'conflict', 'Only an email that failed to send can be retried')
  await requireMailSendLimit(env, access.mailboxId, access.user.id)
  await deliverOutboundEmail(env, body.messageId, { retryUncertain: uncertain && body.confirmUncertain })
  waitUntil(signalMailChanged(env, access.mailboxId, id))
  const message = await loadMailMessage(env, body.messageId, access.user.id)
  if (!message) fail(404, 'not_found', 'Email not found')
  return { message }
})
