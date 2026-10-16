import { verifyInstallationIdentity, signInstallationIdentity } from '../shared/installation-identity'
import type { PublicUser } from '../shared/types'
import type { L4Env } from './env'

export async function userFromTicket(env: L4Env, token: string): Promise<PublicUser | null> {
  if (!token) return null
  const ticket = await env.TICKETS.get(`wsticket:${token}`)
  if (ticket) {
    await env.TICKETS.delete(`wsticket:${token}`)
    if (ticket.startsWith('{')) {
      if (!env.LLLL_INSTALLATION_KEY || !env.LLLL_INSTALLATION_ORIGIN || !env.LLLL_SERVER_ID) return null
      try {
        const saved = JSON.parse(ticket) as { userId: string; installationToken: string }
        const identity = await verifyInstallationIdentity(saved.installationToken, env.LLLL_INSTALLATION_KEY, env.LLLL_INSTALLATION_ORIGIN, env.LLLL_SERVER_ID)
        if (identity.sub !== saved.userId) return null
        const proof = await signInstallationIdentity(identity, env.LLLL_INSTALLATION_KEY, env.LLLL_INSTALLATION_ORIGIN, env.LLLL_SERVER_ID)
        const response = await fetch(`${env.LLLL_INSTALLATION_INTERNAL_ORIGIN || env.LLLL_INSTALLATION_ORIGIN}/api/installation/socket-session/${encodeURIComponent(env.LLLL_SERVER_ID)}`, { method: 'POST', headers: { 'x-llll-identity': proof } })
        if (!response.ok) return null
        return loadUser(env, saved.userId)
      }
      catch { return null }
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
