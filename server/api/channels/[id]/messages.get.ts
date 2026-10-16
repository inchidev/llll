import { and, desc, eq, lt } from 'drizzle-orm'
import { messages } from '../../../../drizzle/schema'
import { requireChannelMember } from '../../../utils/guards'
import { cf } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import { hydrateMessages } from '../../../utils/messages'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const access = await requireChannelMember(event, id)
  const query = getQuery(event)
  const limit = Math.min(Number(query.limit) || 50, 50)
  const cursor = typeof query.cursor === 'string' ? query.cursor : null
  const { env } = cf(event)
  const db = getDb(env.DB)

  const filters = cursor
    ? and(eq(messages.channelId, id), lt(messages.id, cursor))
    : eq(messages.channelId, id)

  const rows = await db.select().from(messages).where(filters).orderBy(desc(messages.id)).limit(limit + 1)
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const chronological = [...page].reverse()
  const dtos = await hydrateMessages(env, chronological, access.user.id)
  const read = await env.DB.prepare(
    'SELECT last_read_message_id as lastReadMessageId FROM channel_reads WHERE channel_id = ? AND user_id = ?',
  ).bind(id, access.user.id).first<{ lastReadMessageId: string | null }>()
  return {
    frozen: access.frozen,
    messages: dtos,
    nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
    lastReadMessageId: read?.lastReadMessageId ?? null,
  }
})
