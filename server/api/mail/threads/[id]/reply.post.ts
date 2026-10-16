import { z } from 'zod'
import { newId, nowIso } from '../../../../../shared/ids'
import type { MailMessageDTO } from '../../../../../shared/types'
import { requireMailboxPermission } from '../../../../utils/workspace-mail'
import { cf, fail } from '../../../../utils/cf'
import { parseBody } from '../../../../utils/validate'
import { loadMailMessage } from '../../../../utils/mail-data'
import { deliverOutboundEmail, replyRecipients, replyThreading } from '../../../../utils/mail-outbound'
import { findOutboundRequest, isUniqueViolation } from '../../../../utils/mail-requests'
import { workspaceEmailAvailable } from '../../../../../workers/mail-transport'
import { signalMailChanged } from '../../../../../workers/mail-events'

const schema = z.object({
  content: z.string().trim().min(1).max(100_000),
  /** Set by the client for each reply, so retrying one is not emailed twice. */
  clientId: z.string().trim().min(8).max(80).optional(),
})

export default defineEventHandler(async (event): Promise<{ message: MailMessageDTO }> => {
  const id = getRouterParam(event, 'id')!
  const access = await requireMailboxPermission(event, id, 'send')
  if (access.channel.type !== 'thread') fail(404, 'not_found', 'Email conversation not found')
  const body = parseBody(schema, await readBody(event))
  const { env, waitUntil } = cf(event)
  if (!workspaceEmailAvailable(env)) fail(503, 'mail_unavailable', 'Workspace email sending is not bound')

  const existing = body.clientId ? await findOutboundRequest(env, access.mailboxId, body.clientId) : null
  if (existing && existing.threadChannelId !== id) fail(409, 'conflict', 'This request was already used for another email')
  let messageId = existing?.messageId ?? null
  if (!messageId) {
    const [mailbox, threading] = await Promise.all([
      env.DB.prepare(
        `SELECT lower(mb.local_part || '@' || d.domain) as address, mb.display_name as displayName
         FROM email_mailboxes mb JOIN email_domains d ON d.id = mb.domain_id WHERE mb.channel_id = ?`,
      ).bind(access.mailboxId).first<{ address: string; displayName: string }>(),
      replyThreading(env, id),
    ])
    if (!mailbox) fail(404, 'not_found', 'Mailbox not found')
    const recipients = await replyRecipients(env, id, mailbox.address)
    if (!recipients.length) fail(409, 'no_recipient', 'This conversation has no external recipient')
    const created = nowIso()
    messageId = newId()
    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO messages (id, channel_id, author_id, content, reply_to_id, edited_at, deleted_at, created_at)
           VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?)`,
        ).bind(messageId, id, access.user.id, body.content, created),
        env.DB.prepare(
          `INSERT INTO email_messages
           (message_id, thread_channel_id, mailbox_channel_id, direction, from_address, from_name, to_json, cc_json, bcc_json,
            rfc_message_id, in_reply_to, references_json, delivery_status, raw_r2_key, client_request_id, created_at)
           VALUES (?, ?, ?, 'outbound', ?, ?, ?, '[]', '[]', NULL, ?, ?, 'pending', NULL, ?, ?)`,
        ).bind(
          messageId, id, access.mailboxId, mailbox.address, mailbox.displayName, JSON.stringify(recipients),
          threading.inReplyTo, JSON.stringify(threading.references), body.clientId ?? null, created,
        ),
        env.DB.prepare('UPDATE email_threads SET last_message_at = ?, updated_at = ? WHERE channel_id = ?').bind(created, created, id),
      ])
    }
    catch (error) {
      // The same reply arrived twice at once; the other request created it.
      const raced = body.clientId && isUniqueViolation(error) ? await findOutboundRequest(env, access.mailboxId, body.clientId) : null
      if (!raced) throw error
      messageId = raced.messageId
    }
  }

  await deliverOutboundEmail(env, messageId)
  waitUntil(signalMailChanged(env, access.mailboxId, id))
  const message = await loadMailMessage(env, messageId, access.user.id)
  if (!message) fail(404, 'not_found', 'Email not found')
  return { message }
})
