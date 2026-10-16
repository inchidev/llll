import { isStoredAvatarKey } from '~~/shared/avatar'
import { WORKSPACE_ID } from '~~/shared/ids'
import type { UserKind } from '~~/shared/types'

export const agentAvatarSources = [
  '/avatars/agents/cyan.png',
  '/avatars/agents/violet.png',
  '/avatars/agents/amber.png',
  '/avatars/agents/mint.png',
] as const

export function agentAvatarSrc(id: string): string {
  let hash = 2166136261
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return agentAvatarSources[(hash >>> 0) % agentAvatarSources.length]!
}

/**
 * Same-origin path for a participant's picture: an uploaded avatar when one exists, a generated
 * image for agents, and nothing for humans without an upload so the caller falls back to initials.
 * API paths are versioned by object key so caches never serve a replaced picture.
 */
export function userAvatarSrc(user: { id: string, kind: UserKind, avatarR2Key?: string | null }): string | undefined {
  if (isStoredAvatarKey(user.avatarR2Key)) {
    const path = user.kind === 'agent'
      ? `/api/workspaces/${WORKSPACE_ID}/agents/${user.id}/avatar`
      : `/api/users/${user.id}/avatar`
    return `${path}?v=${encodeURIComponent(user.avatarR2Key)}`
  }
  return user.kind === 'agent' ? agentAvatarSrc(user.id) : undefined
}
