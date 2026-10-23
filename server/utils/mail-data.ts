import { inArray } from 'drizzle-orm'
import { emailMessages, messages } from '../../drizzle/schema'
import type { L4Env } from '../../workers/env'
import type { MailMessageDTO, MailThreadDTO } from '../../shared/types'
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
