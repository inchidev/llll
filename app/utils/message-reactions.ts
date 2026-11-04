import type { ReactionDTO } from '~~/shared/types'

export type ReactionChange = {
  emoji: string
  userId: string
  op: 'add' | 'remove'
}

export function applyReactionChange(
  current: ReactionDTO[],
  change: ReactionChange,
  selfUserId?: string,
): ReactionDTO[] {
  const reactions = current.map(reaction => ({ ...reaction }))
  const index = reactions.findIndex(reaction => reaction.emoji === change.emoji)
  const mine = Boolean(selfUserId && change.userId === selfUserId)

  if (change.op === 'add') {
    if (index === -1) return [...reactions, { emoji: change.emoji, count: 1, me: mine }]
    const reaction = reactions[index]!
    if (mine && reaction.me) return reactions
    reactions[index] = { ...reaction, count: reaction.count + 1, me: reaction.me || mine }
    return reactions
  }

  if (index === -1) return reactions
  const reaction = reactions[index]!
  if (mine && !reaction.me) return reactions
  if (reaction.count <= 1) return reactions.filter((_, reactionIndex) => reactionIndex !== index)
  reactions[index] = { ...reaction, count: reaction.count - 1, me: mine ? false : reaction.me }
  return reactions
}
