import { and, desc, eq, isNull } from 'drizzle-orm'
import { messagePins, messages } from '../../../../drizzle/schema'
import { requireChannelAccess } from '../../../utils/guards'
import { cf } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import { hydrateMessages } from '../../../utils/messages'

export default defineEventHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const access = await requireChannelAccess(event, channelId)
  const { env } = cf(event)
  const db = getDb(env.DB)
  const rows = await db.select({ message: messages })
    .from(messagePins)
    .innerJoin(messages, eq(messages.id, messagePins.messageId))
    .where(and(eq(messages.channelId, channelId), isNull(messages.deletedAt)))
    .orderBy(desc(messagePins.pinnedAt))
  return { messages: await hydrateMessages(env, rows.map(row => row.message), access.user.id) }
})
