import type { PublicUser } from './types'

export const DM_GROUP_MAX = 25
export const DM_GROUP_MIN = 3

export function dmTitle(name: string | null | undefined, participants: PublicUser[], meId: string): string {
  const trimmed = name?.trim()
  if (trimmed && trimmed !== 'dm') return trimmed
  const others = participants.filter((p) => p.id !== meId)
  if (others.length === 0) return 'Direct Message'
  if (others.length === 1) return others[0]!.displayName
  const first = others.slice(0, 3).map((p) => p.displayName)
  if (others.length <= 3) return first.join(', ')
  return `${first.join(', ')} and ${others.length - 3} others`
}

export function isDmType(type: string): boolean {
  return type === 'dm'
}

/** Agent DMs are visible to workspace managers and to the participating Agent itself. */
export function canAccessAgentConversation(
  userKind: 'human' | 'agent',
  canManageAgents: boolean,
  hasAgentParticipant: boolean,
): boolean {
  return !hasAgentParticipant || canManageAgents || userKind === 'agent'
}
