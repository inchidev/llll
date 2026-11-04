import { fail, cf } from '../../../utils/cf'
import { requireChannelAccess } from '../../../utils/guards'
import { nowIso } from '../../../../shared/ids'
import { signalChannelRead } from '../../../../workers/channel-activity'

import { advanceChatRead } from '../../../../workers/chat-attention'

/**
 * Marks a conversation read without opening it: the conversation itself and the threads this
 * member already follows. Unfollowed threads stay unfollowed, as when reading in place.
 */
export default defineEventHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const access = await requireChannelAccess(event, channelId)
  if (access.mailPermission) fail(400, 'mail_read', 'Mark mail as read from the mailbox')
  const { env, waitUntil } = cf(event)
  const userId = access.user.id
  const latest = await env.DB.prepare(`SELECT c.id AS channelId, MAX(m.id) AS messageId, COALESCE(a.read_generation, 0) AS generation
    FROM channels c
    JOIN messages m ON m.channel_id = c.id AND m.deleted_at IS NULL
    LEFT JOIN channel_attention a ON a.channel_id = c.id AND a.user_id = ?
    WHERE c.id = ? OR (c.parent_id = ? AND c.type = 'thread' AND a.following = 1)
    GROUP BY c.id`).bind(userId, channelId, channelId).all<{ channelId: string; messageId: string; generation: number }>()
  const rows = latest.results ?? []
  const at = nowIso()
  if (rows.length) await env.DB.batch(rows.map(row => advanceChatRead(env.DB, row.channelId, userId, row.messageId, at, row.generation)))
  for (const row of rows) waitUntil(signalChannelRead(env, userId, row.channelId, row.messageId))
  return { ok: true, channels: rows.length }
})
