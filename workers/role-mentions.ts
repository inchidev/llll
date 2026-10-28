import { extractRoleMentionIds } from '../shared/mentions'
import { isDmType } from '../shared/dm'
import { hasPermission, Permission } from '../shared/permissions'
import type { L4Env } from './env'

/** One role mention reaches at most this many Members. */
export const ROLE_MENTION_LIMIT = 500

/** A Member reached by a role mention, and the Role that reached them. */
export type RoleMention = { userId: string; roleId: string }

type Root = { id: string; type: string; visibility: string }

async function accessRoot(env: L4Env, channelId: string): Promise<Root | null> {
  const channel = await env.DB.prepare('SELECT id, type, visibility, parent_id AS parentId FROM channels WHERE id = ?')
    .bind(channelId).first<Root & { parentId: string | null }>()
  if (!channel || channel.type !== 'thread' || !channel.parentId) return channel
  return env.DB.prepare('SELECT id, type, visibility FROM channels WHERE id = ?').bind(channel.parentId).first<Root>()
}

/**
 * The people a message's `<@&role>` tokens reach: active humans holding a mentioned Role
 * who can read the conversation, never its author and never more than ROLE_MENTION_LIMIT.
 * Anyone may mention a mentionable Role; the Owner and Members with Manage channels may
 * mention any Role. Other tokens stay in the text and reach nobody. Members the message
 * mentions directly are left to that mention.
 *
 * Agents are left out on purpose: invoking an Agent takes a direct mention.
 */
export async function roleMentionRecipients(env: L4Env, message: { channelId: string; authorId: string; content: string; mentions: string[] }): Promise<RoleMention[]> {
  const roleIds = extractRoleMentionIds(message.content)
  if (!roleIds.length) return []
  const root = await accessRoot(env, message.channelId)
  // Everyone in a DM already hears every message.
  if (!root || isDmType(root.type)) return []
  const [author, discussion, mailbox] = await Promise.all([
    env.DB.prepare(`SELECT r.permissions_bitmask AS perms, s.owner_id AS ownerId
      FROM users u JOIN roles r ON r.id = u.role_id CROSS JOIN server s WHERE u.id = ? AND u.status = 'active'`)
      .bind(message.authorId).first<{ perms: number; ownerId: string }>(),
    env.DB.prepare('SELECT 1 AS found FROM tasks WHERE discussion_channel_id = ? LIMIT 1').bind(root.id).first(),
    env.DB.prepare('SELECT enabled FROM email_mailboxes WHERE channel_id = ?').bind(root.id).first<{ enabled: number }>(),
  ])
  if (!author) return []
  // Task discussions follow per-Task and per-Project grants; their readers cannot be listed here.
  if (discussion || (mailbox && !mailbox.enabled)) return []
  const anyRole = author.ownerId === message.authorId || hasPermission(author.perms, Permission.manageChannels)
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
  const rows = await env.DB.prepare(`SELECT u.id AS userId, u.role_id AS roleId
    FROM users u JOIN roles r ON r.id = u.role_id CROSS JOIN server s
    WHERE u.status = 'active' AND u.kind = 'human' AND u.id <> ?
      AND u.role_id IN (SELECT value FROM json_each(?)) AND (? OR r.mentionable = 1)
      ${access.map(clause => `AND ${clause}`).join(' ')}
    ORDER BY u.id LIMIT ?`)
    .bind(message.authorId, JSON.stringify(roleIds), anyRole ? 1 : 0, ...binds, ROLE_MENTION_LIMIT)
    .all<RoleMention>()
  // A direct mention already reaches its Member.
  const direct = new Set(message.mentions)
  return (rows.results ?? []).filter(row => !direct.has(row.userId))
}

/** Records role mentions in one statement, however many Members they reach. */
export function roleMentionStatement(env: L4Env, messageId: string, mentions: RoleMention[]): D1PreparedStatement | null {
  if (!mentions.length) return null
  return env.DB.prepare(`INSERT OR IGNORE INTO message_mentions (message_id, user_id, role_id)
    SELECT ?, json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?)`)
    .bind(messageId, JSON.stringify(mentions.map(mention => [mention.userId, mention.roleId])))
}

/** The Roles whose mention reached someone, for highlighting the message for their holders. */
export function mentionedRoleIds(mentions: RoleMention[]): string[] {
  return [...new Set(mentions.map(mention => mention.roleId))]
}
