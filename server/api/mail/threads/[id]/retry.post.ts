import { z } from 'zod'
import type { MailMessageDTO } from '../../../../../shared/types'
import { requireMailboxPermission } from '../../../../utils/workspace-mail'
import { cf, fail } from '../../../../utils/cf'
import { parseBody } from '../../../../utils/validate'
import { loadMailMessage } from '../../../../utils/mail-data'
import { deliverOutboundEmail } from '../../../../utils/mail-outbound'
import { workspaceEmailAvailable } from '../../../../../workers/mail-transport'
import { signalMailChanged } from '../../../../../workers/mail-events'

const schema = z.object({ messageId: z.string().min(8).max(80) })

/** Tries again to deliver an email whose last attempt failed. */
export default defineEventHandler(async (event): Promise<{ message: MailMessageDTO }> => {
  const id = getRouterParam(event, 'id')!
  const access = await requireMailboxPermission(event, id, 'send')
  if (access.channel.type !== 'thread') fail(404, 'not_found', 'Email conversation not found')
  const body = parseBody(schema, await readBody(event))
  const { env, waitUntil } = cf(event)
  if (!workspaceEmailAvailable(env)) fail(503, 'mail_unavailable', 'Workspace email sending is not bound')
  const row = await env.DB.prepare(
    `SELECT delivery_status as deliveryStatus FROM email_messages
     WHERE message_id = ? AND thread_channel_id = ? AND direction = 'outbound'`,
  ).bind(body.messageId, id).first<{ deliveryStatus: string }>()
  if (!row) fail(404, 'not_found', 'Email not found')
  if (row.deliveryStatus !== 'failed') fail(409, 'conflict', 'Only an email that failed to send can be retried')
  await deliverOutboundEmail(env, body.messageId)
  waitUntil(signalMailChanged(env, access.mailboxId, id))
  const message = await loadMailMessage(env, body.messageId, access.user.id)
  if (!message) fail(404, 'not_found', 'Email not found')
  return { message }
})
