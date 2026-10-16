import type { WorkspaceRealtimeEvent } from '../shared/workspace-realtime'

export type WorkspaceSocketAttachment = { userId: string; lastActive: number; visible: boolean }

type WorkspaceSocket = {
  deserializeAttachment: () => WorkspaceSocketAttachment | null
  send: (payload: string) => void
}

export function sendWorkspaceEvent(
  sockets: Iterable<WorkspaceSocket>,
  recipientIds: ReadonlySet<string>,
  event: WorkspaceRealtimeEvent,
) {
  const payload = JSON.stringify(event)
  for (const socket of sockets) {
    const attachment = socket.deserializeAttachment()
    if (!attachment?.userId || !recipientIds.has(attachment.userId)) continue
    try { socket.send(payload) }
    catch { /* disconnected */ }
  }
}
