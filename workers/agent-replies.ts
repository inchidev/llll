import { newId, nowIso } from '../shared/ids'
import { threadTitle } from '../shared/threads'

export type AgentReplyTarget = {
  channelId: string
  parentChannelId: string | null
  parentMessageId: string | null
  created: boolean
}

/** Agent replies start a thread in every conversation; an existing thread remains the target. */
export async function ensureAgentReplyTarget(
  db: D1Database,
  sourceChannelId: string,
  sourceMessageId: string,
): Promise<AgentReplyTarget> {
  const source = await db.prepare(
    'SELECT id, type, visibility FROM channels WHERE id = ?',
  ).bind(sourceChannelId).first<{ id: string; type: string; visibility: string }>()
  if (!source) throw new Error('Channel not found')
  if (source.type === 'thread') return { channelId: source.id, parentChannelId: null, parentMessageId: null, created: false }

  const root = await db.prepare(
    'SELECT content FROM messages WHERE id = ? AND channel_id = ?',
  ).bind(sourceMessageId, sourceChannelId).first<{ content: string }>()
  if (!root) throw new Error('Message not found')

  const existing = await db.prepare(
    "SELECT id FROM channels WHERE parent_message_id = ? AND type = 'thread'",
  ).bind(sourceMessageId).first<{ id: string }>()
  if (existing) {
    return { channelId: existing.id, parentChannelId: sourceChannelId, parentMessageId: sourceMessageId, created: false }
  }

  const filenames = root.content.trim() ? [] : (await db.prepare('SELECT filename FROM attachments WHERE message_id=? ORDER BY created_at,id LIMIT 20').bind(sourceMessageId).all<{ filename: string }>()).results.map(item => item.filename)
  const id = newId()
  const timestamp = nowIso()
  await db.prepare(
    `INSERT OR IGNORE INTO channels
      (id, name, topic, type, visibility, position, live_meeting_id, parent_id, parent_message_id, created_at, updated_at)
     VALUES (?, ?, '', 'thread', ?, 0, NULL, ?, ?, ?, ?)`,
  ).bind(id, threadTitle(root.content, filenames), source.visibility, sourceChannelId, sourceMessageId, timestamp, timestamp).run()

  const target = await db.prepare(
    "SELECT id FROM channels WHERE parent_message_id = ? AND type = 'thread'",
  ).bind(sourceMessageId).first<{ id: string }>()
  if (!target) throw new Error('Could not create reply thread')
  return {
    channelId: target.id,
    parentChannelId: sourceChannelId,
    parentMessageId: sourceMessageId,
    created: target.id === id,
  }
}
