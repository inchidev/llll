import { z } from 'zod'
import { newId, nowIso } from '../../../../../shared/ids'
import type { MailMessageDTO, MailThreadDTO } from '../../../../../shared/types'
import { mergeMailAddresses } from '../../../../../shared/mail'
import { requireMailboxPermission } from '../../../../utils/workspace-mail'
import { cf, fail } from '../../../../utils/cf'
import { parseBody } from '../../../../utils/validate'
import { loadMailMessage, mailThreadDto } from '../../../../utils/mail-data'
import { deliverOutboundEmail } from '../../../../utils/mail-outbound'
import { findOutboundRequest, isUniqueViolation } from '../../../../utils/mail-requests'
import { workspaceEmailAvailable } from '../../../../../workers/mail-transport'
import { signalMailChanged } from '../../../../../workers/mail-events'

const schema = z.object({
  to: z.array(z.string().trim().email().max(254)).min(1).max(50),
  subject: z.string().trim().min(1).max(500),
  content: z.string().trim().min(1).max(100_000),
  /** Set by the client for each email, so retrying one is not emailed twice. */
  clientId: z.string().trim().min(8).max(80).optional(),
})

export default defineEventHandler(async (event): Promise<{ threadId: string; thread: MailThreadDTO; message: MailMessageDTO }> => {
  const mailboxId = getRouterParam(event, 'id')!
  const access = await requireMailboxPermission(event, mailboxId, 'send')
  if (access.channel.type !== 'text') fail(404, 'not_found', 'Mailbox not found')
  const body = parseBody(schema, await readBody(event))
  const { env, waitUntil } = cf(event)
  if (!workspaceEmailAvailable(env)) fail(503, 'mail_unavailable', 'Workspace email sending is not bound')

  const existing = body.clientId ? await findOutboundRequest(env, mailboxId, body.clientId) : null
  let messageId = existing?.messageId ?? null
  let threadId = existing?.threadChannelId ?? null
  if (!messageId || !threadId) {
    const mailbox = await env.DB.prepare(
      `SELECT lower(mb.local_part || '@' || d.domain) as address, mb.display_name as displayName
       FROM email_mailboxes mb JOIN email_domains d ON d.id = mb.domain_id WHERE mb.channel_id = ?`,
    ).bind(mailboxId).first<{ address: string; displayName: string }>()
    if (!mailbox) fail(404, 'not_found', 'Mailbox not found')
    const recipients = mergeMailAddresses(body.to).filter(value => value !== mailbox.address)
    if (!recipients.length) fail(400, 'bad_request', 'Enter at least one external recipient')
    const created = nowIso()
    messageId = newId()
    threadId = newId()
    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO messages (id, channel_id, author_id, content, reply_to_id, edited_at, deleted_at, created_at)
           VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?)`,
        ).bind(messageId, mailboxId, access.user.id, body.content, created),
        env.DB.prepare(
          `INSERT INTO channels (id, name, topic, type, visibility, category_id, position, huddle_meeting_id, parent_id, parent_message_id, created_at, updated_at)
           VALUES (?, ?, '', 'thread', 'private', NULL, 0, NULL, ?, ?, ?, ?)`,
        ).bind(threadId, body.subject.slice(0, 80), mailboxId, messageId, created, created),
        env.DB.prepare(
          `INSERT INTO email_threads (channel_id, mailbox_channel_id, subject, status, participants_json, last_message_at, created_at, updated_at)
           VALUES (?, ?, ?, 'inbox', ?, ?, ?, ?)`,
        ).bind(threadId, mailboxId, body.subject, JSON.stringify(recipients), created, created, created),
        env.DB.prepare(
          `INSERT INTO email_messages
           (message_id, thread_channel_id, mailbox_channel_id, direction, from_address, from_name, to_json, cc_json, bcc_json,
            rfc_message_id, in_reply_to, references_json, delivery_status, raw_r2_key, client_request_id, created_at)
           VALUES (?, ?, ?, 'outbound', ?, ?, ?, '[]', '[]', NULL, NULL, '[]', 'pending', NULL, ?, ?)`,
        ).bind(messageId, threadId, mailboxId, mailbox.address, mailbox.displayName, JSON.stringify(recipients), body.clientId ?? null, created),
      ])
    }
    catch (error) {
      // The same email arrived twice at once; the other request created it.
      const raced = body.clientId && isUniqueViolation(error) ? await findOutboundRequest(env, mailboxId, body.clientId) : null
      if (!raced) throw error
      messageId = raced.messageId
      threadId = raced.threadChannelId
    }
  }

  await deliverOutboundEmail(env, messageId)
  waitUntil(signalMailChanged(env, mailboxId, threadId))
  const [message, thread] = await Promise.all([
    loadMailMessage(env, messageId, access.user.id),
    env.DB.prepare(
      `SELECT channel_id as channelId, mailbox_channel_id as mailboxChannelId, subject, status,
         participants_json as participantsJson, last_message_at as lastMessageAt
       FROM email_threads WHERE channel_id = ?`,
    ).bind(threadId).first<Parameters<typeof mailThreadDto>[0]>(),
  ])
  if (!message || !thread) fail(404, 'not_found', 'Email not found')
  return { threadId, thread: mailThreadDto({ ...thread, preview: message.content }), message }
})
