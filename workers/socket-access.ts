import type { SocketSession } from './ticket'

type AuthenticatedSocket = {
  deserializeAttachment(): SocketSession | null
  close(code: number, reason: string): void
}

/** Hibernating sockets outlive membership changes; admission is not a read grant. */
export async function authorizedSockets<T extends AuthenticatedSocket>(
  sockets: T[],
  canReceive: (userId: string, session: SocketSession) => Promise<boolean>,
): Promise<T[]> {
  const checks = new Map<string, Promise<boolean>>()
  const allowed = await Promise.all(sockets.map(async socket => {
    const session = socket.deserializeAttachment()
    const userId = session?.userId
    if (!userId || !session) return false
    const key = JSON.stringify([userId, session.sessionId || null])
    let check = checks.get(key)
    if (!check) {
      check = Promise.resolve().then(() => canReceive(userId, session)).catch(() => false)
      checks.set(key, check)
    }
    if (await check) return true
    try { socket.close(4403, 'access_revoked') }
    catch { /* Already disconnected. Never send when authorization fails. */ }
    return false
  }))
  return sockets.filter((_, index) => allowed[index])
}
