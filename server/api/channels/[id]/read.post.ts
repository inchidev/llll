import { fail, cf } from '../../../utils/cf'
import { requireChannelAccess } from '../../../utils/guards'
import { nowIso } from '../../../../shared/ids'
import { signalChannelRead } from '../../../../workers/channel-activity'

const advance = `INSERT INTO channel_reads (channel_id, user_id, last_read_message_id, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(channel_id, user_id) DO UPDATE
  SET last_read_message_id = excluded.last_read_message_id, updated_at = excluded.updated_at
  WHERE channel_reads.last_read_message_id IS NULL OR channel_reads.last_read_message_id < excluded.last_read_message_id`

/**
 * Marks a conversation read without opening it: the conversation itself and the threads this
 * member already follows. Threads they never opened stay unfollowed, as when reading in place.
 */
export default defineEventHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const access = await requireChannelAccess(event, channelId)
  if (access.mailPermission) fail(400, 'mail_read', 'Mark mail as read from the mailbox')
  const { env, waitUntil } = cf(event)
  const userId = access.user.id
  const latest = await env.DB.prepare(`SELECT c.id AS channelId, MAX(m.id) AS messageId
    FROM channels c
    JOIN messages m ON m.channel_id = c.id AND m.deleted_at IS NULL
    LEFT JOIN channel_reads r ON r.channel_id = c.id AND r.user_id = ?
    WHERE c.id = ? OR (c.parent_id = ? AND c.type = 'thread' AND r.last_read_message_id IS NOT NULL)
    GROUP BY c.id`).bind(userId, channelId, channelId).all<{ channelId: string; messageId: string }>()
  const rows = latest.results ?? []
  const at = nowIso()
  if (rows.length) await env.DB.batch(rows.map(row => env.DB.prepare(advance).bind(row.channelId, userId, row.messageId, at)))
  for (const row of rows) waitUntil(signalChannelRead(env, userId, row.channelId, row.messageId))
  return { ok: true, channels: rows.length }
})
