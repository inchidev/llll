import { requireMember } from '../../../utils/guards'
import { requireChannelAccessForMember } from '../../../utils/channel-access'
import { cf } from '../../../utils/cf'
import { spaceSql } from '../../../../shared/spaces'
import { channelPath } from '../../../../shared/paths'
import { notificationPreview } from '../../../../shared/notifications'
import { messageThreadTitle } from '../../../utils/thread-title'
import type { FollowedThread } from '../../../../shared/chat-attention'

export default defineEventHandler(async (event) => {
  const member = await requireMember(event, getRouterParam(event, 'id')!)
  const { env } = cf(event)
  const rows = await env.DB.prepare(`SELECT t.id, t.parent_id AS parentId, t.name AS title,
    p.name AS conversation, COALESCE(last.created_at, t.created_at) AS lastMessageAt,
    COALESCE(last.content, '') AS excerpt,
    (SELECT COUNT(*) FROM (SELECT 1 FROM messages m WHERE m.channel_id = t.id AND m.deleted_at IS NULL
      AND m.id > COALESCE(r.last_read_message_id, '') LIMIT 100)) AS unreadCount
    FROM channel_attention a JOIN channels t ON t.id = a.channel_id AND t.type = 'thread'
    JOIN channels p ON p.id = t.parent_id
    LEFT JOIN channel_reads r ON r.channel_id = t.id AND r.user_id = a.user_id
    LEFT JOIN messages last ON last.id = (SELECT id FROM messages WHERE channel_id = t.id AND deleted_at IS NULL ORDER BY id DESC LIMIT 1)
    WHERE a.user_id = ? AND a.following = 1 AND p.archived_at IS NULL
      AND p.space_id IN (${spaceSql(member.authorization)})
      AND NOT EXISTS (SELECT 1 FROM tasks WHERE discussion_channel_id = p.id)
      AND NOT EXISTS (SELECT 1 FROM email_mailboxes WHERE channel_id = p.id)
    ORDER BY (unreadCount > 0) DESC, lastMessageAt DESC, t.id DESC`).bind(member.user.id)
    .all<Omit<FollowedThread, 'path'>>()
  const access = new Map<string, boolean>()
  const threads: FollowedThread[] = []
  for (const row of rows.results) {
    if (!access.has(row.parentId)) {
      try { await requireChannelAccessForMember(env, member, row.parentId); access.set(row.parentId, true) }
      catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 404 && (error as { statusCode?: number }).statusCode !== 403) throw error
        access.set(row.parentId, false)
      }
    }
    if (!access.get(row.parentId)) continue
    threads.push({ ...row, title: await messageThreadTitle(env.DB, row.title, []), excerpt: notificationPreview(row.excerpt, 0),
      path: channelPath(row.parentId, row.id), unreadCount: Number(row.unreadCount) })
  }
  return { threads }
})
