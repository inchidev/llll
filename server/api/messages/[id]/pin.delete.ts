import { eq } from 'drizzle-orm'
import { messages } from '../../../../drizzle/schema'
import { cf, fail } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import { fanoutMessagePin, requireMessagePinAccess } from '../../../utils/message-pins'

export default defineEventHandler(async (event) => {
  const messageId = getRouterParam(event, 'id')!
  const { env } = cf(event)
  const db = getDb(env.DB)
  const message = (await db.select().from(messages).where(eq(messages.id, messageId)).limit(1))[0]
  if (!message) fail(404, 'not_found', 'Message not found')
  await requireMessagePinAccess(event, message.channelId)

  const result = await env.DB.prepare('DELETE FROM message_pins WHERE message_id = ?').bind(messageId).run()
  const removed = result.meta.changes > 0
  if (removed) await fanoutMessagePin(env, message.channelId, messageId, null)
  return { pin: null, removed }
})
