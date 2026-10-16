import { newId, nowIso } from '../shared/ids'
import { threadTitle } from '../shared/threads'

export type AgentReplyTarget = {
  channelId: string
  parentChannelId: string | null
  parentMessageId: string | null
  created: boolean
}

/** A one-to-one DM reply starts a thread; replies elsewhere stay in their source channel. */
export async function ensureAgentReplyTarget(
  db: D1Database,
  sourceChannelId: string,
  sourceMessageId: string,
): Promise<AgentReplyTarget> {
  const source = await db.prepare(
    'SELECT id, type, visibility FROM channels WHERE id = ?',
  ).bind(sourceChannelId).first<{ id: string; type: string; visibility: string }>()
  if (!source) throw new Error('Channel not found')
  if (source.type !== 'dm') {
    return { channelId: source.id, parentChannelId: null, parentMessageId: null, created: false }
  }

  const participants = await db.prepare(
    'SELECT count(*) as count FROM channel_members WHERE channel_id = ?',
  ).bind(sourceChannelId).first<{ count: number }>()
  if (Number(participants?.count ?? 0) !== 2) {
    return { channelId: source.id, parentChannelId: null, parentMessageId: null, created: false }
  }

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

  const id = newId()
  const timestamp = nowIso()
  await db.prepare(
    `INSERT OR IGNORE INTO channels
      (id, name, topic, type, visibility, position, huddle_meeting_id, parent_id, parent_message_id, created_at, updated_at)
     VALUES (?, ?, '', 'thread', ?, 0, NULL, ?, ?, ?, ?)`,
  ).bind(id, threadTitle(root.content), source.visibility, sourceChannelId, sourceMessageId, timestamp, timestamp).run()

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
