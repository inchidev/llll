import { z } from 'zod'
import { requireChannelAccess } from '../../../utils/guards'
import { cf, fail } from '../../../utils/cf'
import { signalChatAttention } from '../../../../workers/channel-activity'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const access = await requireChannelAccess(event, id)
  if (access.mailPermission) fail(400, 'mail_read', 'Mark mail as unread from the mailbox')
  const { messageId } = z.object({ messageId: z.string().min(1).max(100) }).parse(await readBody(event))
  const { env, waitUntil } = cf(event)
  const message = await env.DB.prepare('SELECT id FROM messages WHERE id = ? AND channel_id = ? AND deleted_at IS NULL').bind(messageId, id).first()
  if (!message) fail(404, 'not_found', 'Message not found')
  const userId = access.user.id
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO channel_attention (channel_id, user_id, following, read_generation) VALUES (?, ?, ?, 1)
      ON CONFLICT(channel_id, user_id) DO UPDATE SET read_generation = channel_attention.read_generation + 1,
      following = CASE WHEN excluded.following = 1 THEN 1 ELSE channel_attention.following END`)
      .bind(id, userId, Number(access.channel.type === 'thread')),
    env.DB.prepare(`INSERT INTO channel_reads (channel_id, user_id, last_read_message_id, updated_at)
      VALUES (?, ?, (SELECT MAX(id) FROM messages WHERE channel_id = ? AND id < ? AND deleted_at IS NULL), ?)
      ON CONFLICT(channel_id, user_id) DO UPDATE SET last_read_message_id = excluded.last_read_message_id, updated_at = excluded.updated_at`)
      .bind(id, userId, id, messageId, new Date().toISOString()),
  ])
  waitUntil(signalChatAttention(env, userId, id))
  return { ok: true }
})
