import type { PublicUser } from '../shared/types'
import type { L4Env } from './env'

export async function userFromTicket(env: L4Env, token: string): Promise<PublicUser | null> {
  if (!token) return null
  const ticket = await env.TICKETS.get(`wsticket:${token}`)
  if (ticket) {
    await env.TICKETS.delete(`wsticket:${token}`)
    if (ticket.startsWith('{')) {
      try {
        const saved = JSON.parse(ticket) as { userId: string; sessionId: string }
        const session = await env.DB.prepare('SELECT id FROM auth_sessions WHERE id = ? AND user_id = ? AND expires_at > ?').bind(saved.sessionId, saved.userId, Date.now()).first()
        return session ? loadUser(env, saved.userId) : null
      } catch { return null }
    }
    return loadUser(env, ticket)
  }
  return null
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
