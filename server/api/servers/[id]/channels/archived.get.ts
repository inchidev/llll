import { Permission } from '../../../../../shared/permissions'
import type { ArchivedChannelDTO } from '../../../../../shared/types'
import { cf } from '../../../../utils/cf'
import { requireMember } from '../../../../utils/guards'

/** Archived Chat channels this manager can open, most recently archived first. */
export default defineEventHandler(async (event) => {
  const member = await requireMember(event, getRouterParam(event, 'id')!, Permission.manageChannels)
  const { env } = cf(event)
  const rows = await env.DB.prepare(`SELECT c.id, c.name, c.topic, c.visibility, c.created_by AS createdBy,
      c.archived_at AS archivedAt, u.id AS archivedById, COALESCE(u.nickname, u.display_name) AS archivedByName
    FROM channels c LEFT JOIN users u ON u.id = c.archived_by
    WHERE c.type = 'text' AND c.archived_at IS NOT NULL
      AND (c.visibility = 'server' OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?))
      AND NOT EXISTS (SELECT 1 FROM email_mailboxes mb WHERE mb.channel_id = c.id)
      AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.discussion_channel_id = c.id)
    ORDER BY c.archived_at DESC, c.id DESC LIMIT 500`).bind(member.user.id).all<{
    id: string, name: string, topic: string, visibility: 'server' | 'private', createdBy: string | null
    archivedAt: string, archivedById: string | null, archivedByName: string | null
  }>()
  const channels: ArchivedChannelDTO[] = (rows.results ?? []).map(row => ({
    id: row.id,
    name: row.name,
    topic: row.topic,
    visibility: row.visibility,
    createdBy: row.createdBy,
    archivedAt: row.archivedAt,
    archivedBy: row.archivedById ? { id: row.archivedById, displayName: row.archivedByName ?? '' } : null,
  }))
  return { channels }
})
