import { hasPermission, Permission } from '../../shared/permissions'
import { reachableSpaceIds, spaceSqlList } from '../../shared/spaces'
import { channelUnreadCounts } from '../../workers/unread'
import type { L4Env } from '../../workers/env'
import { requireChannelAccessForMember, type ServerMembership } from './channel-access'

const MENTION_LIMIT = 40

/**
 * Which of a person's Spaces have something new: an unread conversation, an unread mention, or a
 * decision on a Run they started. One yes per Space and nothing more, so the switcher can point at
 * another Space without any of its content leaving it. Only Spaces the person is in are looked at,
 * which leaves out a Space the Owner manages without having joined.
 */
export async function loadSpaceAttention(env: L4Env, member: ServerMembership): Promise<{ spaceIds: string[] }> {
  const ids = reachableSpaceIds(member.authorization)
  // With one Space there is no other to point at.
  if (ids.length < 2) return { spaceIds: [] }
  const spaces = spaceSqlList(ids), me = member.user.id
  const canSeeAgents = member.isOwner || hasPermission(member.perms, Permission.useAgents)
  // What Chat and Agents list for this person: the same filters as `channels.get` and `dms/index.get`.
  const conversations = await env.DB.prepare(`SELECT c.id, c.space_id AS spaceId FROM channels c
    WHERE c.space_id IN (${spaces}) AND c.archived_at IS NULL AND (
      (c.type = 'dm' AND EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?1 AND cm.hidden_at IS NULL)
        ${canSeeAgents ? '' : `AND NOT EXISTS (SELECT 1 FROM channel_members a JOIN users u ON u.id = a.user_id WHERE a.channel_id = c.id AND u.kind = 'agent')`})
      OR (c.type NOT IN ('dm', 'thread')
        AND (c.visibility = 'server' OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?1))
        AND NOT EXISTS (SELECT 1 FROM email_mailboxes mb WHERE mb.channel_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.discussion_channel_id = c.id))
    )`).bind(me).all<{ id: string; spaceId: string }>()
  const list = conversations.results ?? []
  const waiting = new Set<string>()
  const unread = await channelUnreadCounts(env.DB, me, list.map(channel => channel.id))
  for (const channel of list) if ((unread.get(channel.id) ?? 0) > 0) waiting.add(channel.spaceId)

  // A mention can sit in a thread or a conversation that is not listed above, so it is checked by access.
  const mentions = await env.DB.prepare(`SELECT DISTINCT m.channel_id AS channelId, c.space_id AS spaceId
    FROM message_mentions mm
    JOIN messages m ON m.id = mm.message_id
    JOIN channels c ON c.id = m.channel_id
    LEFT JOIN channel_reads r ON r.channel_id = m.channel_id AND r.user_id = mm.user_id
    WHERE mm.user_id = ?1 AND m.author_id <> mm.user_id AND m.deleted_at IS NULL AND c.space_id IN (${spaces})
      AND (r.last_read_message_id IS NULL OR m.id > r.last_read_message_id)
    LIMIT ${MENTION_LIMIT}`).bind(me).all<{ channelId: string; spaceId: string }>()
  for (const mention of mentions.results ?? []) {
    if (waiting.has(mention.spaceId)) continue
    const access = await requireChannelAccessForMember(env, member, mention.channelId).catch(() => null)
    if (access && !access.archivedAt) waiting.add(mention.spaceId)
  }

  const now = new Date().toISOString()
  const [approvals, publications] = await env.DB.batch<{ spaceId: string }>([
    env.DB.prepare(`SELECT DISTINCT c.space_id AS spaceId FROM factory_actions a JOIN agent_runs r ON r.id = a.run_id JOIN channels c ON c.id = r.channel_id
      WHERE c.space_id IN (${spaces}) AND r.initiated_by = ? AND a.status = 'pending' AND a.expires_at > ?`).bind(me, now),
    env.DB.prepare(`SELECT DISTINCT c.space_id AS spaceId FROM agent_run_publications p JOIN agent_runs r ON r.id = p.run_id JOIN channels c ON c.id = r.channel_id
      WHERE c.space_id IN (${spaces}) AND r.initiated_by = ? AND p.status = 'pending' AND p.expires_at > ?`).bind(me, now),
  ])
  for (const row of [...(approvals?.results ?? []), ...(publications?.results ?? [])]) waiting.add(row.spaceId)
  return { spaceIds: [...waiting] }
}
