import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { messageReactions, messages } from '../../../../drizzle/schema'
import { nowIso } from '../../../../shared/ids'
import { requireChannelAccess } from '../../../utils/guards'
import { requireActiveChannel } from '../../../utils/channel-access'
import { cf, fail } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import { fanoutDm } from '../../../utils/dms'
import { parseBody } from '../../../utils/validate'
import { reactionEmojiSchema, reactionRate, requireRate } from '../../../utils/message-service'

const bodySchema = z.object({
  emoji: reactionEmojiSchema,
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const { env } = cf(event)
  const db = getDb(env.DB)
  const row = (await db.select().from(messages).where(eq(messages.id, id)).limit(1))[0]
  if (!row) fail(404, 'not_found', 'Message not found')
  const access = await requireChannelAccess(event, row.channelId)
  requireActiveChannel(access)
  if (row.deletedAt) fail(409, 'deleted', 'Message was deleted')
  const body = parseBody(bodySchema, await readBody(event))
  await requireRate(env, reactionRate(access.user.id), 'Too many reactions. Slow down.')
  const match = and(eq(messageReactions.messageId, id), eq(messageReactions.userId, access.user.id), eq(messageReactions.emoji, body.emoji))
  // Each statement is atomic, so a double click toggles or no-ops instead of hitting the primary key.
  if ((await db.delete(messageReactions).where(match).returning()).length) {
    await fanoutDm(env, row.channelId, { t: 'reaction', messageId: id, emoji: body.emoji, userId: access.user.id, op: 'remove' })
    return { op: 'remove' as const }
  }
  const added = await db.insert(messageReactions).values({ messageId: id, userId: access.user.id, emoji: body.emoji, createdAt: nowIso() })
    .onConflictDoNothing().returning()
  if (added.length) await fanoutDm(env, row.channelId, { t: 'reaction', messageId: id, emoji: body.emoji, userId: access.user.id, op: 'add' })
  return { op: 'add' as const }
})
