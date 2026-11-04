import { chatNotificationAllowed, type ChatNotificationLevel } from '../shared/chat-attention'
import { filterLiveRecipients } from './live-audience'
import type { L4Env } from './env'

/** Applies preferences after the caller has resolved its existing DM/mention audience.
 * Extra all-message/follow notifications are limited to ordinary chats, never Task/Mail.
 */
export async function chatAlertRecipients(env: L4Env, input: {
  rootId: string; channelId: string; actorId: string; dm: boolean; mentioned: string[]; candidates: string[]; edit?: boolean
}): Promise<string[]> {
  const extra = input.edit ? [] : (await env.DB.prepare(`SELECT DISTINCT a.user_id AS id FROM channel_attention a
    WHERE ((a.channel_id = ?1 AND a.notifications = 'all') OR (a.channel_id = ?2 AND a.following = 1))
      AND a.user_id <> ?3
      AND NOT EXISTS (SELECT 1 FROM tasks WHERE discussion_channel_id = ?1)
      AND NOT EXISTS (SELECT 1 FROM email_mailboxes WHERE channel_id = ?1)`)
    .bind(input.rootId, input.channelId, input.actorId).all<{ id: string }>()).results ?? []
  const added = extra.length ? await filterLiveRecipients(env, input.rootId, extra.map(row => row.id)) : []
  const candidates = [...new Set([...input.candidates, ...added])].filter(id => id !== input.actorId)
  if (!candidates.length) return []
  const states = await env.DB.prepare(`SELECT u.id, COALESCE(a.notifications, 'default') AS notifications,
    COALESCE(t.following, 0) AS following FROM users u
    LEFT JOIN channel_attention a ON a.channel_id = ?1 AND a.user_id = u.id
    LEFT JOIN channel_attention t ON t.channel_id = ?2 AND t.user_id = u.id
    WHERE u.id IN (SELECT value FROM json_each(?3))`)
    .bind(input.rootId, input.channelId, JSON.stringify(candidates))
    .all<{ id: string; notifications: ChatNotificationLevel; following: number }>()
  const byUser = new Map(states.results.map(row => [row.id, row]))
  const mentioned = new Set(input.mentioned)
  return candidates.filter(id => {
    const state = byUser.get(id)
    return chatNotificationAllowed(state?.notifications ?? 'default', {
      dm: input.dm, thread: input.channelId !== input.rootId, following: Boolean(state?.following), mentioned: mentioned.has(id),
    })
  })
}

/** Recheck a queued message against today's preferences, including after a restart. */
export async function chatPushStillWanted(db: Pick<D1Database, 'prepare'>, messageId: string, recipientId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT m.author_id AS authorId, root.type, c.type = 'thread' AS thread,
    COALESCE(a.notifications, 'default') AS notifications, COALESCE(t.following, 0) AS following,
    EXISTS(SELECT 1 FROM message_mentions mm WHERE mm.message_id = m.id AND mm.user_id = ?2) AS mentioned
    FROM messages m JOIN channels c ON c.id = m.channel_id
    JOIN channels root ON root.id = CASE WHEN c.type = 'thread' THEN c.parent_id ELSE c.id END
    LEFT JOIN channel_attention a ON a.channel_id = root.id AND a.user_id = ?2
    LEFT JOIN channel_attention t ON t.channel_id = c.id AND t.user_id = ?2
    WHERE m.id = ?1 AND m.deleted_at IS NULL`).bind(messageId, recipientId)
    .first<{ authorId: string; type: string; thread: number; notifications: ChatNotificationLevel; following: number; mentioned: number }>()
  if (!row) return false
  // Personal reminders are deliberately authored by their recipient.
  if (row.authorId === recipientId) return true
  return chatNotificationAllowed(row.notifications, { dm: row.type === 'dm', thread: Boolean(row.thread), following: Boolean(row.following), mentioned: Boolean(row.mentioned) })
}
