import { nowIso } from '../shared/ids'

export const AGENT_REACTION_EMOJIS = ['👀', '✅', '❌', '⏹️'] as const
export type AgentReactionEmoji = typeof AGENT_REACTION_EMOJIS[number]
export type AgentReactionChange = {
  removed: AgentReactionEmoji[]
  added: AgentReactionEmoji | null
}

/** Replaces this Agent's lifecycle reaction without touching human reactions. */
export async function replaceAgentReaction(
  db: D1Database,
  messageId: string,
  agentId: string,
  emoji: AgentReactionEmoji,
): Promise<AgentReactionChange> {
  const existing = await db.prepare(
    `SELECT emoji FROM message_reactions
     WHERE message_id = ? AND user_id = ? AND emoji IN (?, ?, ?, ?)`,
  ).bind(messageId, agentId, ...AGENT_REACTION_EMOJIS).all<{ emoji: AgentReactionEmoji }>()
  const previous = (existing.results ?? []).map(row => row.emoji)
  if (previous.length === 1 && previous[0] === emoji) return { removed: [], added: null }
  if (emoji === '👀' && previous.some(value => value === '✅' || value === '❌' || value === '⏹️')) {
    return { removed: [], added: null }
  }

  await db.batch([
    db.prepare(
      `DELETE FROM message_reactions
       WHERE message_id = ? AND user_id = ? AND emoji IN (?, ?, ?, ?)`,
    ).bind(messageId, agentId, ...AGENT_REACTION_EMOJIS),
    db.prepare(
      `INSERT OR IGNORE INTO message_reactions (message_id, user_id, emoji, created_at)
       VALUES (?, ?, ?, ?)`,
    ).bind(messageId, agentId, emoji, nowIso()),
  ])
  return {
    removed: previous.filter(value => value !== emoji),
    added: previous.includes(emoji) ? null : emoji,
  }
}
