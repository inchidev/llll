import { asc, eq, or } from 'drizzle-orm'
import { messages } from '../../../../drizzle/schema'
import type { MailMessageDTO, MailThreadDTO } from '../../../../shared/types'
import { requireMailboxPermission } from '../../../utils/workspace-mail'
import { cf, fail } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import { hydrateMailMessages, mailThreadDto } from '../../../utils/mail-data'

/** A conversation and its messages. Opening it does not mark it read; see read.post. */
export default defineEventHandler(async (event): Promise<{ thread: MailThreadDTO; messages: MailMessageDTO[] }> => {
  const id = getRouterParam(event, 'id')!
  const access = await requireMailboxPermission(event, id, 'read')
  if (access.channel.type !== 'thread') fail(404, 'not_found', 'Email conversation not found')
  const { env } = cf(event)
  const db = getDb(env.DB)
  // The conversation's first message lives in the mailbox; the rest in the conversation.
  const parentMessageId = access.channel.parentMessageId
  const [row, messageRows] = await Promise.all([
    env.DB.prepare(
      `SELECT channel_id as channelId, mailbox_channel_id as mailboxChannelId, subject, status,
         participants_json as participantsJson, last_message_at as lastMessageAt
       FROM email_threads WHERE channel_id = ?`,
    ).bind(id).first<Parameters<typeof mailThreadDto>[0]>(),
    db.select().from(messages)
      .where(parentMessageId ? or(eq(messages.channelId, id), eq(messages.id, parentMessageId)) : eq(messages.channelId, id))
      .orderBy(asc(messages.createdAt), asc(messages.id)),
  ])
  if (!row) fail(404, 'not_found', 'Email conversation not found')
  const hydrated = await hydrateMailMessages(env, messageRows, access.user.id)
  return {
    thread: { ...mailThreadDto({ ...row, preview: hydrated.at(-1)?.content ?? '' }), unread: false },
    messages: hydrated,
  }
})
