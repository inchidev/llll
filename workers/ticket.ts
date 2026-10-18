import type { PublicUser } from '../shared/types'
import type { L4Env } from './env'

export type SocketSession = { userId: string; sessionId?: string }

/** Every use rechecks the local session; a held socket is not a session grant. */
export async function socketSessionActive(env: L4Env, session: SocketSession): Promise<boolean> {
  if (!session.sessionId) {
    if (env.AUTH_MODE?.trim().toLowerCase() !== 'access') return false
    return Boolean(await env.DB.prepare("SELECT id FROM users WHERE id = ? AND status = 'active'").bind(session.userId).first())
  }
  return Boolean(await env.DB.prepare(
    "SELECT s.id FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.user_id = ? AND s.expires_at > ? AND u.status = 'active'",
  ).bind(session.sessionId, session.userId, Date.now()).first())
}

export async function sessionFromTicket(env: L4Env, token: string): Promise<{ user: PublicUser; sessionId?: string } | null> {
  if (!token) return null
  const ticket = await env.TICKETS.get(`wsticket:${token}`)
  if (!ticket) return null
  await env.TICKETS.delete(`wsticket:${token}`)
  let session: SocketSession
  try {
    session = ticket.startsWith('{') ? JSON.parse(ticket) : { userId: ticket }
    if (typeof session.userId !== 'string' || (session.sessionId !== undefined && typeof session.sessionId !== 'string')) return null
    if (!await socketSessionActive(env, session)) return null
    const user = await loadUser(env, session.userId)
    return user ? { user, sessionId: session.sessionId } : null
  } catch { return null }
}

async function loadUser(env: L4Env, userId: string): Promise<PublicUser | null> {
  const row = await env.DB.prepare(
    "SELECT id, kind, display_name, avatar_r2_key FROM users WHERE id = ? AND status = 'active'",
  ).bind(userId).first<{ id: string; kind: 'human' | 'agent'; display_name: string; avatar_r2_key: string | null }>()
  if (!row) return null
  return {
    id: row.id,
    kind: row.kind,
    displayName: row.display_name,
    avatarR2Key: row.avatar_r2_key,
  }
}
