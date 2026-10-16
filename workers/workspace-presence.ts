import type { PresenceStatus } from '../shared/types'
import type { WorkspaceSocketAttachment } from './workspace-events'

export const PRESENCE_IDLE_MS = 5 * 60 * 1000

type PresenceSocket = {
  deserializeAttachment: () => WorkspaceSocketAttachment | null
}

export function workspacePresence(
  sockets: Iterable<PresenceSocket>,
  now = Date.now(),
): Array<{ userId: string; status: PresenceStatus }> {
  const latest = new Map<string, number>()
  for (const socket of sockets) {
    const attachment = socket.deserializeAttachment()
    if (!attachment?.userId || !attachment.visible) continue
    latest.set(attachment.userId, Math.max(latest.get(attachment.userId) ?? 0, attachment.lastActive))
  }
  return [...latest.entries()].map(([userId, lastActive]) => ({
    userId,
    status: now - lastActive > PRESENCE_IDLE_MS ? 'idle' : 'online',
  }))
}
