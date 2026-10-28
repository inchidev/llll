import type { PublicUser } from '../shared/types'
import type { L4Env } from './env'
import { messageNotificationStatement } from './notifications'

type MessageEdit = {
  id: string
  channelId: string
  author: PublicUser
  content: string
  /** Active Members mentioned by the new content. */
  mentions: string[]
  editedAt: string
}

/**
 * Rewrites an edited message and its mentions. Members mentioned for the first time by this
 * edit are notified; the push event shares the send's ID, so each Member hears of a message
 * at most once however often it is edited. Returns the newly mentioned Member IDs.
 */
export async function persistMessageEdit(env: L4Env, edit: MessageEdit): Promise<string[]> {
  const previous = await env.DB.prepare('SELECT user_id FROM message_mentions WHERE message_id = ?')
    .bind(edit.id).all<{ user_id: string }>()
  const before = new Set((previous.results ?? []).map(row => row.user_id))
  const added = edit.mentions.filter(userId => !before.has(userId) && userId !== edit.author.id)
  let notification: D1PreparedStatement | null = null
  if (added.length) {
    const attachments = await env.DB.prepare('SELECT COUNT(*) AS n FROM attachments WHERE message_id = ?').bind(edit.id).first<{ n: number }>()
    notification = await messageNotificationStatement(env, {
      id: edit.id,
      channelId: edit.channelId,
      author: edit.author,
      content: edit.content,
      mentions: added,
      attachmentCount: Number(attachments?.n ?? 0),
      edit: true,
    })
  }
  await env.DB.batch([
    env.DB.prepare('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?').bind(edit.content, edit.editedAt, edit.id),
    env.DB.prepare('DELETE FROM message_mentions WHERE message_id = ?').bind(edit.id),
    ...edit.mentions.map(userId => env.DB.prepare(
      'INSERT OR IGNORE INTO message_mentions (message_id, user_id) VALUES (?, ?)',
    ).bind(edit.id, userId)),
    ...(notification ? [notification] : []),
  ])
  return added
}
