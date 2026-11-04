import type { ServerRealtimeEvent } from '../shared/server-realtime'

export type ServerSocketAttachment = { userId: string; sessionId?: string; lastActive: number; visible: boolean }

type ServerSocket = {
  deserializeAttachment: () => ServerSocketAttachment | null
  send: (payload: string) => void
}

export function sendServerEvent(
  sockets: Iterable<ServerSocket>,
  recipientIds: ReadonlySet<string>,
  event: ServerRealtimeEvent,
) {
  const payload = JSON.stringify(event)
  for (const socket of sockets) {
    const attachment = socket.deserializeAttachment()
    if (!attachment?.userId || !recipientIds.has(attachment.userId)) continue
    try { socket.send(payload) }
    catch { /* disconnected */ }
  }
}
