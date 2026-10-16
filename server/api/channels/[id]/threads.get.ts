import { and, count, desc, eq, inArray, max } from 'drizzle-orm'
import { channels, messages } from '../../../../drizzle/schema'
import type { ChannelThreadDTO } from '../../../../shared/types'
import { threadTitle } from '../../../../shared/threads'
import { requireChannelAccess } from '../../../utils/guards'
import { cf } from '../../../utils/cf'
import { getDb } from '../../../utils/db'

export default defineEventHandler(async (event) => {
  const parentId = getRouterParam(event, 'id')!
  const access = await requireChannelAccess(event, parentId)
  const { env } = cf(event)
  const db = getDb(env.DB)
  const rows = await db.select().from(channels)
    .where(and(eq(channels.parentId, parentId), eq(channels.type, 'thread')))
    .orderBy(desc(channels.updatedAt))
  if (!rows.length) return { threads: [] satisfies ChannelThreadDTO[] }

  const parentMessageIds = rows.map(row => row.parentMessageId).filter((id): id is string => Boolean(id))
  const threadIds = rows.map(row => row.id)
  const [rootRows, replyRows] = await Promise.all([
    db.select().from(messages).where(inArray(messages.id, parentMessageIds)),
    db.select({ channelId: messages.channelId, replyCount: count(messages.id), lastReplyAt: max(messages.createdAt) })
      .from(messages)
      .where(inArray(messages.channelId, threadIds))
      .groupBy(messages.channelId),
  ])
  const { hydrateMessages } = await import('../../../utils/messages')
  const roots = await hydrateMessages(env, rootRows, access.user.id)
  const rootsById = new Map(roots.map(root => [root.id, root]))
  const repliesByChannel = new Map(replyRows.map(row => [row.channelId, row]))
  const threads: ChannelThreadDTO[] = rows.flatMap((row) => {
    if (!row.parentMessageId) return []
    const root = rootsById.get(row.parentMessageId)
    if (!root) return []
    const replies = repliesByChannel.get(row.id)
    return [{
      id: row.id,
      parentMessageId: row.parentMessageId,
      title: threadTitle(root.content, root.attachments.map(attachment => attachment.filename)),
      author: root.author,
      replyCount: Number(replies?.replyCount ?? 0),
      lastReplyAt: replies?.lastReplyAt ?? null,
      createdAt: row.createdAt,
    }]
  })
  return { threads }
})
