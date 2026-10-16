import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { messageReactions, messages } from '../../../../drizzle/schema'
import { nowIso } from '../../../../shared/ids'
import { requireChannelAccess } from '../../../utils/guards'
import { cf, fail } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import { fanoutDm } from '../../../utils/dms'
import { parseBody } from '../../../utils/validate'

const bodySchema = z.object({
  emoji: z.string().min(1).max(16),
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const { env } = cf(event)
  const db = getDb(env.DB)
  const row = (await db.select().from(messages).where(eq(messages.id, id)).limit(1))[0]
  if (!row) fail(404, 'not_found', 'Message not found')
  const access = await requireChannelAccess(event, row.channelId)
  const body = parseBody(bodySchema, await readBody(event))
  const existing = (await db.select().from(messageReactions).where(and(
    eq(messageReactions.messageId, id),
    eq(messageReactions.userId, access.user.id),
    eq(messageReactions.emoji, body.emoji),
  )).limit(1))[0]
  if (existing) {
    await db.delete(messageReactions).where(and(
      eq(messageReactions.messageId, id),
      eq(messageReactions.userId, access.user.id),
      eq(messageReactions.emoji, body.emoji),
    ))
    await fanoutDm(env, row.channelId, { t: 'reaction', messageId: id, emoji: body.emoji, userId: access.user.id, op: 'remove' })
    return { op: 'remove' as const }
  }
  await db.insert(messageReactions).values({
    messageId: id,
    userId: access.user.id,
    emoji: body.emoji,
    createdAt: nowIso(),
  })
  await fanoutDm(env, row.channelId, { t: 'reaction', messageId: id, emoji: body.emoji, userId: access.user.id, op: 'add' })
  return { op: 'add' as const }
})
