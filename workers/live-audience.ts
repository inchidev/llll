import { hasPermission, Permission } from '../shared/permissions'
import { parseResourceAccess, resourceAccessAllows } from '../shared/resource-access'
import type { L4Env } from './env'

/** A Task discussion's audience: the Owner, or a Role with Read tasks that reaches the Task's Board. */
export function readsTaskBoard(user: { id: string, permissions: number, resourceAccess: string | null, ownerId: string }, boardId: string): boolean {
  return user.id === user.ownerId || (hasPermission(user.permissions, Permission.readTasks)
    && resourceAccessAllows(parseResourceAccess(user.resourceAccess), 'boards', boardId))
}

/** Apply conversation access to both Live events and push recipients. */
export async function filterLiveRecipients(env: L4Env, channelId: string, candidates: string[]): Promise<string[]> {
  if (!candidates.length) return []
  const root = await env.DB.prepare(`SELECT r.id,r.type,r.visibility,t.board_id AS boardId,
    EXISTS(SELECT 1 FROM email_mailboxes m WHERE m.channel_id=r.id) AS mailbox,
    EXISTS(SELECT 1 FROM channel_members cm JOIN users u ON u.id=cm.user_id WHERE cm.channel_id=r.id AND u.kind='agent') AS hasAgent
    FROM channels c JOIN channels r ON r.id=CASE WHEN c.type='thread' THEN c.parent_id ELSE c.id END
    LEFT JOIN tasks t ON t.discussion_channel_id=r.id WHERE c.id=?`).bind(channelId)
    .first<{ id: string, type: string, visibility: string, boardId: string | null, mailbox: number, hasAgent: number }>()
  if (!root || root.mailbox) return []
  type Recipient = { id: string, permissions: number, resourceAccess: string, ownerId: string, participant: number }
  const rows: Recipient[] = []
  const unique = [...new Set(candidates)]
  for (let offset = 0; offset < unique.length; offset += 90) {
    const page = unique.slice(offset, offset + 90)
    const result = await env.DB.prepare(`SELECT u.id,r.permissions_bitmask AS permissions,r.resource_access_json AS resourceAccess,s.owner_id AS ownerId,
      EXISTS(SELECT 1 FROM channel_members cm WHERE cm.channel_id=? AND cm.user_id=u.id) AS participant
      FROM users u JOIN roles r ON r.id=u.role_id CROSS JOIN server s
      WHERE u.id IN (${page.map(() => '?').join(',')}) AND u.status='active' AND u.kind='human' ORDER BY u.id`)
      .bind(root.id, ...page).all<Recipient>()
    rows.push(...result.results)
  }
  return rows.filter(user => {
    if ((root.type === 'dm' || root.visibility === 'private') && !user.participant) return false
    const owner = user.id === user.ownerId
    if (root.type === 'dm' && root.hasAgent && !owner && !hasPermission(user.permissions, Permission.useAgents)) return false
    return !root.boardId || readsTaskBoard(user, root.boardId)
  }).map(user => user.id).sort()
}
