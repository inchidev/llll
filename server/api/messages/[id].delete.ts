import { eq } from 'drizzle-orm'
import { messages } from '../../../drizzle/schema'
import { nowIso } from '../../../shared/ids'
import { Permission } from '../../../shared/permissions'
import { requireChannelMember } from '../../utils/guards'
import { cf, fail } from '../../utils/cf'
import { getDb } from '../../utils/db'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const { env } = cf(event)
  const db = getDb(env.DB)
  const row = (await db.select().from(messages).where(eq(messages.id, id)).limit(1))[0]
  if (!row) fail(404, 'not_found', 'Message not found')
  const member = await requireChannelMember(event, row.channelId, Permission.sendMessages)
  if (row.authorId !== member.user.id) fail(403, 'forbidden', 'Not your message')
  const pin = await env.DB.prepare('SELECT message_id FROM message_pins WHERE message_id = ?').bind(id).first()
  await env.DB.batch([
    env.DB.prepare('UPDATE messages SET deleted_at = ?, content = ? WHERE id = ?').bind(nowIso(), '', id),
    env.DB.prepare('DELETE FROM message_pins WHERE message_id = ?').bind(id),
  ])
  try {
    const stub = asRpc<{ fanout: (msg: unknown) => Promise<void> }>(env.CHANNEL_DO.getByName(`channel:${row.channelId}`))
    await stub.fanout({ t: 'message.delete', id })
    if (pin) await stub.fanout({ t: 'pin', messageId: id, pin: null })
  }
  catch { /* ignore */ }
  return { ok: true }
})
