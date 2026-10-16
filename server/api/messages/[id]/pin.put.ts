import { eq } from 'drizzle-orm'
import { messages } from '../../../../drizzle/schema'
import { nowIso } from '../../../../shared/ids'
import { cf, fail } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import {
  fanoutMessagePin,
  INSERT_MESSAGE_PIN_SQL,
  loadMessagePin,
  requireMessagePinAccess,
} from '../../../utils/message-pins'

export default defineEventHandler(async (event) => {
  const messageId = getRouterParam(event, 'id')!
  const { env } = cf(event)
  const db = getDb(env.DB)
  const message = (await db.select().from(messages).where(eq(messages.id, messageId)).limit(1))[0]
  if (!message) fail(404, 'not_found', 'Message not found')
  const access = await requireMessagePinAccess(event, message.channelId)
  if (message.deletedAt) fail(409, 'deleted', 'Message was deleted')

  const result = await env.DB.prepare(INSERT_MESSAGE_PIN_SQL)
    .bind(messageId, access.user.id, nowIso())
    .run()
  const pin = await loadMessagePin(env, messageId)
  if (!pin) fail(409, 'conflict', 'Message could not be pinned')
  const created = result.meta.changes > 0
  if (created) await fanoutMessagePin(env, message.channelId, messageId, pin)
  return { pin, created }
})
