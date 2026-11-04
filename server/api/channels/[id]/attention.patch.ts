import { z } from 'zod'
import { requireChannelAccess } from '../../../utils/guards'
import { cf, fail } from '../../../utils/cf'
import { CHAT_NOTIFICATION_LEVELS } from '../../../../shared/chat-attention'
import { chatAttention } from '../../../../workers/chat-attention'
import { signalChatAttention } from '../../../../workers/channel-activity'

const schema = z.object({ following: z.boolean().optional(), notifications: z.enum(CHAT_NOTIFICATION_LEVELS).optional() }).strict()

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const access = await requireChannelAccess(event, id)
  const input = schema.parse(await readBody(event))
  const thread = access.channel.type === 'thread'
  if (access.mailPermission || (input.following !== undefined && !thread) || (input.notifications !== undefined && thread)) {
    fail(400, 'chat_attention', 'Follow a thread or change notifications on its conversation')
  }
  const { env, waitUntil } = cf(event)
  const userId = access.user.id
  // Follow starts at today's tail; repeating it must not clear new replies.
  const statements: D1PreparedStatement[] = []
  if (input.following) statements.push(env.DB.prepare(`INSERT INTO channel_reads (channel_id, user_id, last_read_message_id, updated_at)
    SELECT ?1, ?2, (SELECT MAX(id) FROM messages WHERE channel_id = ?1 AND deleted_at IS NULL), ?3
    WHERE NOT EXISTS (SELECT 1 FROM channel_attention WHERE channel_id = ?1 AND user_id = ?2 AND following = 1)
    ON CONFLICT(channel_id, user_id) DO UPDATE SET last_read_message_id = excluded.last_read_message_id, updated_at = excluded.updated_at
    WHERE channel_reads.last_read_message_id IS NULL OR channel_reads.last_read_message_id < excluded.last_read_message_id`)
    .bind(id, userId, new Date().toISOString()))
  statements.push(env.DB.prepare(`INSERT INTO channel_attention (channel_id, user_id, following, notifications)
    VALUES (?, ?, COALESCE(?, 0), COALESCE(?, 'default'))
    ON CONFLICT(channel_id, user_id) DO UPDATE
    SET following = COALESCE(?, channel_attention.following), notifications = COALESCE(?, channel_attention.notifications)`)
    .bind(id, userId, input.following === undefined ? null : Number(input.following), input.notifications ?? null,
      input.following === undefined ? null : Number(input.following), input.notifications ?? null))
  await env.DB.batch(statements)
  waitUntil(signalChatAttention(env, userId, id))
  return chatAttention(env.DB, id, userId)
})
