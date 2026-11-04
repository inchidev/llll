import type { ChatAttention } from '../shared/chat-attention'

export async function chatAttention(db: Pick<D1Database, 'prepare'>, channelId: string, userId: string): Promise<ChatAttention> {
  const row = await db.prepare(`SELECT following, notifications, read_generation AS readGeneration
    FROM channel_attention WHERE channel_id = ? AND user_id = ?`).bind(channelId, userId).first<ChatAttention>()
  return { following: Boolean(row?.following), notifications: row?.notifications ?? 'default', readGeneration: row?.readGeneration ?? 0 }
}

/** A delayed read from an already-open tab cannot undo an explicit Mark unread. */
export function advanceChatRead(db: Pick<D1Database, 'prepare'>, channelId: string, userId: string, messageId: string, at: string, generation: number) {
  return db.prepare(`INSERT INTO channel_reads (channel_id, user_id, last_read_message_id, updated_at)
    SELECT ?1, ?2, ?3, ?4
    WHERE COALESCE((SELECT read_generation FROM channel_attention WHERE channel_id = ?1 AND user_id = ?2), 0) = ?5
    ON CONFLICT(channel_id, user_id) DO UPDATE
    SET last_read_message_id = excluded.last_read_message_id, updated_at = excluded.updated_at
    WHERE channel_reads.last_read_message_id IS NULL OR channel_reads.last_read_message_id < excluded.last_read_message_id`)
    .bind(channelId, userId, messageId, at, generation)
}
