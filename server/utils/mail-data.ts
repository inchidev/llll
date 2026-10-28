import { inArray } from 'drizzle-orm'
import { emailMessages, messages } from '../../drizzle/schema'
import type { L4Env } from '../../workers/env'
import type { MailboxDTO, MailMessageDTO, MailThreadDTO } from '../../shared/types'
import { mailAddressList, mailDeliveryUncertain } from '../../shared/mail'
import { readableMailContent } from '../../shared/mail-content'
import { getDb } from './db'
import { hydrateMessages } from './messages'

export async function hydrateMailMessages(env: L4Env, rows: Array<typeof messages.$inferSelect>, viewerId: string): Promise<MailMessageDTO[]> {
  if (!rows.length) return []
  const db = getDb(env.DB)
  const [base, extensions] = await Promise.all([
    hydrateMessages(env, rows, viewerId),
    db.select().from(emailMessages).where(inArray(emailMessages.messageId, rows.map(row => row.id))),
  ])
  const byId = new Map(extensions.map(row => [row.messageId, row]))
  return base.map((message) => {
    const email = byId.get(message.id)
    return {
      ...message,
      content: email?.direction === 'inbound' ? readableMailContent(message.content) : message.content,
      author: email?.direction === 'inbound'
        ? { ...message.author, displayName: email.fromName || email.fromAddress }
        : message.author,
      email: email
        ? {
            direction: email.direction,
            fromAddress: email.fromAddress,
            fromName: email.fromName,
            to: mailAddressList(email.toJson),
            cc: mailAddressList(email.ccJson),
            bcc: mailAddressList(email.bccJson),
            replyTo: mailAddressList(email.replyToJson),
            deliveryStatus: email.deliveryStatus,
            deliveryError: email.deliveryError,
            deliveryUncertain: mailDeliveryUncertain(email),
          }
        : null,
    }
  })
}

/** One mail message by id, shaped as the thread view shows it. */
export async function loadMailMessage(env: L4Env, messageId: string, viewerId: string): Promise<MailMessageDTO | null> {
  const rows = await getDb(env.DB).select().from(messages).where(inArray(messages.id, [messageId]))
  return (await hydrateMailMessages(env, rows, viewerId))[0] ?? null
}

type ThreadRow = {
  channelId: string
  mailboxChannelId: string
  subject: string
  status: MailThreadDTO['status']
  participantsJson: string
  lastMessageAt: string
  preview?: string
  previewInbound?: number | boolean
  unread?: number
}

export function mailThreadDto(row: ThreadRow): MailThreadDTO {
  return {
    channelId: row.channelId,
    mailboxChannelId: row.mailboxChannelId,
    subject: row.subject,
    status: row.status,
    participants: mailAddressList(row.participantsJson),
    preview: (row.previewInbound ? readableMailContent(row.preview ?? '') : row.preview ?? '').slice(0, 240),
    lastMessageAt: row.lastMessageAt,
    unread: Boolean(row.unread),
  }
}

/**
 * Enabled Mailboxes with a grant for the member, and how many Inbox conversations
 * are unread. Callers check the email policy; the channel guard checks each one.
 */
export async function listGrantedMailboxes(env: L4Env, userId: string): Promise<MailboxDTO[]> {
  const rows = await env.DB.prepare(
    `SELECT mb.channel_id as channelId, mb.display_name as displayName, mb.enabled,
       a.permission, lower(mb.local_part || '@' || d.domain) as address,
       (SELECT count(*) FROM email_threads t
        LEFT JOIN channel_reads r ON r.channel_id = t.channel_id AND r.user_id = a.user_id
        WHERE t.mailbox_channel_id = mb.channel_id AND t.status = 'inbox'
          AND (r.last_read_message_id IS NULL OR r.last_read_message_id < (
            SELECT max(em.message_id) FROM email_messages em WHERE em.thread_channel_id = t.channel_id AND em.direction = 'inbound'
          ))) as unreadCount
     FROM email_mailboxes mb
     JOIN email_domains d ON d.id = mb.domain_id
     JOIN email_mailbox_access a ON a.channel_id = mb.channel_id
     WHERE a.user_id = ? AND mb.enabled = 1
     ORDER BY mb.display_name, address`,
  ).bind(userId).all<MailboxDTO>()
  return rows.results || []
}

/** Marks a conversation read up to a message. Reading only ever moves forward. */
export async function markMailThreadRead(env: L4Env, threadId: string, userId: string, messageId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO channel_reads (channel_id, user_id, last_read_message_id, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(channel_id, user_id) DO UPDATE SET last_read_message_id = excluded.last_read_message_id, updated_at = excluded.updated_at
     WHERE channel_reads.last_read_message_id IS NULL OR channel_reads.last_read_message_id < excluded.last_read_message_id`,
  ).bind(threadId, userId, messageId, new Date().toISOString()).run()
}
