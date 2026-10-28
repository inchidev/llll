import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { messages } from '../../../drizzle/schema'
import { extractMentionIds } from '../../../shared/mentions'
import { nowIso } from '../../../shared/ids'
import { Permission } from '../../../shared/permissions'
import { requireChannelMember } from '../../utils/guards'
import { asRpc, cf, fail } from '../../utils/cf'
import { getDb } from '../../utils/db'
import { hydrateMessages } from '../../utils/messages'
import { parseBody } from '../../utils/validate'
import { persistMessageEdit } from '../../../workers/message-edits'
import { signalNotificationOutbox } from '../../../workers/notifications'
import { signalAgentsForMessage } from '../../../workers/agent-ingress'

const bodySchema = z.object({
  content: z.string().min(1).max(2000),
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const { env, waitUntil } = cf(event)
  const db = getDb(env.DB)
  const row = (await db.select().from(messages).where(eq(messages.id, id)).limit(1))[0]
  if (!row) fail(404, 'not_found', 'Message not found')
  if (row.deletedAt) fail(409, 'deleted', 'Message was deleted')
  const member = await requireChannelMember(event, row.channelId, Permission.sendMessages)
  if (row.authorId !== member.user.id) fail(403, 'forbidden', 'Not your message')
  const body = parseBody(bodySchema, await readBody(event))
  const editedAt = nowIso()
  const requestedMentions = extractMentionIds(body.content)
  let mentionIds: string[] = []
  if (requestedMentions.length) {
    const placeholders = requestedMentions.map(() => '?').join(',')
    const rows = await env.DB.prepare(
      `SELECT id FROM users WHERE id IN (${placeholders}) AND status = 'active'`,
    ).bind(...requestedMentions).all<{ id: string }>()
    mentionIds = (rows.results ?? []).map((mention) => mention.id)
  }
  const added = await persistMessageEdit(env, { id, channelId: row.channelId, author: member.user, content: body.content, mentions: mentionIds, editedAt })
  const updated = (await db.select().from(messages).where(eq(messages.id, id)).limit(1))[0]!
  const [dto] = await hydrateMessages(env, [updated], member.user.id)
  try {
    const stub = asRpc<{ fanout: (msg: unknown) => Promise<void> }>(env.CHANNEL_DO.getByName(`channel:${row.channelId}`))
    // The broadcast copy carries no viewer; each client keeps its own reaction highlight.
    await stub.fanout({ t: 'message.update', message: { ...dto!, reactions: dto!.reactions.map(reaction => ({ ...reaction, me: false })) } })
  }
  catch { /* ignore */ }
  if (added.length) {
    waitUntil(signalNotificationOutbox(env))
    waitUntil(signalAgentsForMessage(env, {
      messageId: id,
      channelId: row.channelId,
      authorId: member.user.id,
      authorName: member.user.displayName,
      content: body.content,
      mentionIds: added,
      edit: true,
    }))
  }
  return { message: dto }
})
