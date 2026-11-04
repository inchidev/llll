import type { PublicUser } from '../shared/types'
import type { L4Env } from './env'
import { messageNotificationStatement } from './notifications'
import { mentionFanout, roleMentionStatement } from './role-mentions'

type MessageEdit = {
  id: string
  channelId: string
  author: PublicUser
  content: string
  /** Active Members mentioned by the new content. */
  mentions: string[]
  editedAt: string
}

export type MessageEditResult = {
  /** The stored content: group mentions the author may not use read as plain text. */
  content: string
  /** Members the edit mentions directly for the first time; Agents among them are addressed. */
  added: string[]
  /** Everyone the edit notified, including Members newly reached through a role or group mention. */
  notified: string[]
}

/**
 * Rewrites an edited message and its mentions. Members mentioned for the first time by this
 * edit, directly, through a Role or through `@channel` or `@here`, are notified; the push event shares the send's ID, so each
 * Member hears of a message at most once however often it is edited.
 */
export async function persistMessageEdit(env: L4Env, edit: MessageEdit): Promise<MessageEditResult> {
  const [previous, fanout] = await Promise.all([
    env.DB.prepare('SELECT user_id, role_id FROM message_mentions WHERE message_id = ?')
      .bind(edit.id).all<{ user_id: string; role_id: string | null }>(),
    mentionFanout(env, { channelId: edit.channelId, authorId: edit.author.id, content: edit.content, mentions: edit.mentions }),
  ])
  const { content, recipients: roleMentions } = fanout
  const before = new Set((previous.results ?? []).map(row => row.user_id))
  const beforeDirect = new Set((previous.results ?? []).filter(row => !row.role_id).map(row => row.user_id))
  const added = edit.mentions.filter(userId => !beforeDirect.has(userId) && userId !== edit.author.id)
  const directNotified = edit.mentions.filter(userId => !before.has(userId) && userId !== edit.author.id)
  const roleNotified = roleMentions.map(mention => mention.userId).filter(userId => !before.has(userId))
  let notification: D1PreparedStatement | null = null
  if (directNotified.length || roleNotified.length) {
    const attachments = await env.DB.prepare('SELECT COUNT(*) AS n FROM attachments WHERE message_id = ?').bind(edit.id).first<{ n: number }>()
    notification = await messageNotificationStatement(env, {
      id: edit.id,
      channelId: edit.channelId,
      author: edit.author,
      content,
      mentions: directNotified,
      roleMentions: roleNotified,
      attachmentCount: Number(attachments?.n ?? 0),
      edit: true,
    })
  }
  const roleRows = roleMentionStatement(env, edit.id, roleMentions)
  await env.DB.batch([
    env.DB.prepare('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?').bind(content, edit.editedAt, edit.id),
    env.DB.prepare('DELETE FROM message_mentions WHERE message_id = ?').bind(edit.id),
    ...edit.mentions.map(userId => env.DB.prepare(
      'INSERT OR IGNORE INTO message_mentions (message_id, user_id) VALUES (?, ?)',
    ).bind(edit.id, userId)),
    ...(roleRows ? [roleRows] : []),
    ...(notification ? [notification] : []),
  ])
  return { content, added, notified: notification ? [...new Set([...directNotified, ...roleNotified])] : [] }
}
