type AuthenticatedSocket = {
  deserializeAttachment(): { userId: string } | null
  close(code: number, reason: string): void
}

/** Hibernating sockets outlive membership changes; admission is not a read grant. */
export async function authorizedSockets<T extends AuthenticatedSocket>(
  sockets: T[],
  canReceive: (userId: string) => Promise<boolean>,
): Promise<T[]> {
  const checks = new Map<string, Promise<boolean>>()
  const allowed = await Promise.all(sockets.map(async socket => {
    const userId = socket.deserializeAttachment()?.userId
    if (!userId) return false
    let check = checks.get(userId)
    if (!check) {
      check = Promise.resolve().then(() => canReceive(userId)).catch(() => false)
      checks.set(userId, check)
    }
    if (await check) return true
    try { socket.close(4403, 'access_revoked') }
    catch { /* Already disconnected. Never send when authorization fails. */ }
    return false
  }))
  return sockets.filter((_, index) => allowed[index])
}
