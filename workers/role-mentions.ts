import { extractGroupMentions, extractRoleMentionIds, groupMentionMarker, isGroupMentionMarker, plainGroupMentions } from '../shared/mentions'
import { isDmType } from '../shared/dm'
import { hasPermission, Permission } from '../shared/permissions'
import { getServerId } from '../shared/server-id'
import type { PresenceStatus } from '../shared/types'
import { asRpc, type L4Env } from './env'
import { readsTaskBoard } from './live-audience'

/** One role or group mention reaches at most this many Members. */
export const ROLE_MENTION_LIMIT = 500

/** A Member reached by a role or group mention, and the Role (or group marker) that reached them. */
export type RoleMention = { userId: string; roleId: string }

/** The content to store, with group mentions the author may not use turned back into text, and whom it reaches. */
export type MentionFanout = { content: string; recipients: RoleMention[] }

type Root = { id: string; type: string; visibility: string; archivedAt: string | null }

async function accessRoot(env: L4Env, channelId: string): Promise<Root | null> {
  const columns = 'id, type, visibility, archived_at AS archivedAt'
  const channel = await env.DB.prepare(`SELECT ${columns}, parent_id AS parentId FROM channels WHERE id = ?`)
    .bind(channelId).first<Root & { parentId: string | null }>()
  if (!channel || channel.type !== 'thread' || !channel.parentId) return channel
  return env.DB.prepare(`SELECT ${columns} FROM channels WHERE id = ?`).bind(channel.parentId).first<Root>()
}

/** Members the Server's presence shows online or idle, as the member list's Online filter does. */
async function onlineMembers(env: L4Env): Promise<string[]> {
  try {
    const stub = asRpc<{ snapshot: () => Promise<Array<{ userId: string; status: PresenceStatus }>> }>(env.SERVER_DO.getByName(`server:${await getServerId(env.DB)}`))
    return (await stub.snapshot()).filter(user => user.status !== 'offline').map(user => user.userId)
  }
  catch {
    // Without presence nobody is known to be here.
    return []
  }
}

/**
 * The people a message's `<@&role>`, `<!channel>` and `<!here>` tokens reach: active humans who
 * can read the conversation, never its author and never more than ROLE_MENTION_LIMIT. A role
 * mention reaches the Role's holders; `<!channel>` everyone, `<!here>` those online now.
 * Anyone may mention a mentionable Role; the Owner and Members with Manage channels may mention
 * any Role and use group mentions. Other Role tokens stay in the text and reach nobody; other
 * group tokens become plain `@channel` and `@here`. Members the message mentions directly are
 * left to that mention. Task discussions reach people who can read the Task.
 *
 * Agents are left out on purpose: invoking an Agent takes a direct mention.
 */
export async function mentionFanout(env: L4Env, message: { channelId: string; authorId: string; content: string; mentions: string[] }): Promise<MentionFanout> {
  const roleIds = extractRoleMentionIds(message.content)
  const groups = extractGroupMentions(message.content)
  if (!roleIds.length && !groups.length) return { content: message.content, recipients: [] }
  const author = await env.DB.prepare(`SELECT r.permissions_bitmask AS perms, s.owner_id AS ownerId
    FROM users u JOIN roles r ON r.id = u.role_id CROSS JOIN server s WHERE u.id = ? AND u.status = 'active'`)
    .bind(message.authorId).first<{ perms: number; ownerId: string }>()
  const anyRole = Boolean(author && (author.ownerId === message.authorId || hasPermission(author.perms, Permission.manageChannels)))
  const content = groups.length && !anyRole ? plainGroupMentions(message.content) : message.content
  const none = { content, recipients: [] }
  if (!author || (!roleIds.length && !anyRole)) return none
  const root = await accessRoot(env, message.channelId)
  // Everyone in a DM already hears every message, and an archived channel takes no new messages.
  if (!root || isDmType(root.type) || root.archivedAt) return none
  const [discussion, mailbox] = await Promise.all([
    env.DB.prepare('SELECT board_id AS boardId FROM tasks WHERE discussion_channel_id = ? LIMIT 1').bind(root.id).first<{ boardId: string }>(),
    env.DB.prepare('SELECT enabled FROM email_mailboxes WHERE channel_id = ?').bind(root.id).first<{ enabled: number }>(),
  ])
  if (mailbox && !mailbox.enabled) return none
  const everyone = anyRole && groups.includes('channel')
  const online = anyRole && !everyone && groups.includes('here') ? await onlineMembers(env) : []
  if (!roleIds.length && !everyone && !online.length) return none
  const access: string[] = []
  const binds: unknown[] = []
  if (root.visibility === 'private') {
    access.push('EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = ? AND cm.user_id = u.id)')
    binds.push(root.id)
  }
  if (mailbox) {
    access.push(`EXISTS (SELECT 1 FROM email_mailbox_access a WHERE a.channel_id = ? AND a.user_id = u.id)
      AND (u.id = s.owner_id OR (r.permissions_bitmask & ${Permission.readMail | Permission.sendMail}) != 0)`)
    binds.push(root.id)
  }
  // Board access is checked below, the same way Live events in a discussion are.
  if (discussion) access.push(`(u.id = s.owner_id OR (r.permissions_bitmask & ${Permission.readTasks}) != 0)`)
  const roleMatch = 'u.role_id IN (SELECT value FROM json_each(?)) AND (? OR r.mentionable = 1)'
  const rows = await env.DB.prepare(`SELECT u.id AS userId, CASE WHEN ${roleMatch} THEN u.role_id ELSE ? END AS roleId,
      r.permissions_bitmask AS permissions, r.resource_access_json AS resourceAccess, s.owner_id AS ownerId
    FROM users u JOIN roles r ON r.id = u.role_id CROSS JOIN server s
    WHERE u.status = 'active' AND u.kind = 'human' AND u.id <> ?
      AND ((${roleMatch}) OR ? OR u.id IN (SELECT value FROM json_each(?)))
      ${access.map(clause => `AND ${clause}`).join(' ')}
    ORDER BY u.id ${discussion ? '' : 'LIMIT ?'}`)
    .bind(JSON.stringify(roleIds), anyRole ? 1 : 0, groupMentionMarker(everyone ? 'channel' : 'here'), message.authorId,
      JSON.stringify(roleIds), anyRole ? 1 : 0, everyone ? 1 : 0, JSON.stringify(online), ...binds, ...(discussion ? [] : [ROLE_MENTION_LIMIT]))
    .all<RoleMention & { permissions: number; resourceAccess: string | null; ownerId: string }>()
  // A direct mention already reaches its Member.
  const direct = new Set(message.mentions)
  const recipients = (rows.results ?? [])
    .filter(row => !discussion || readsTaskBoard({ ...row, id: row.userId }, discussion.boardId))
    .slice(0, ROLE_MENTION_LIMIT)
    .filter(row => !direct.has(row.userId))
    .map(({ userId, roleId }) => ({ userId, roleId }))
  return { content, recipients }
}

/** Records role and group mentions in one statement, however many Members they reach. */
export function roleMentionStatement(env: L4Env, messageId: string, mentions: RoleMention[]): D1PreparedStatement | null {
  if (!mentions.length) return null
  return env.DB.prepare(`INSERT OR IGNORE INTO message_mentions (message_id, user_id, role_id)
    SELECT ?, json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?)`)
    .bind(messageId, JSON.stringify(mentions.map(mention => [mention.userId, mention.roleId])))
}

/** The Roles whose mention reached someone, for highlighting the message for their holders. */
export function mentionedRoleIds(mentions: RoleMention[]): string[] {
  return [...new Set(mentions.map(mention => mention.roleId).filter(roleId => !isGroupMentionMarker(roleId)))]
}
