import { encryptSecret, decryptSecret } from '../../../shared/encrypted-secret'
import { randomCode, type CloudflareGrant } from '../../../shared/cloudflare-oauth'
import type { PortalEnv } from './env'

export type DeploymentState = {
  state?: string; verifier?: string; grant?: CloudflareGrant
  accountId?: string; name?: string; version?: string; worker?: string; installationId?: string; databaseId?: string; bucket?: string
  authSecret?: string; setupToken?: string; origin?: string
  step?: number; error?: string; completed?: boolean
}
export async function digest(value: string) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, '0')).join('') }
export async function portalSession(request: Request, env: PortalEnv, create = false) {
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) throw Object.assign(new Error('Configure the deployment service secret (AUTH_SECRET)'), { status: 503 })
  let token = /(?:^|;\s*)llll_deploy=([a-zA-Z0-9_-]{64})(?:;|$)/.exec(request.headers.get('cookie') || '')?.[1]
  if (!token && !create) throw Object.assign(new Error('Start the deployment again'), { status: 401 })
  let fresh = false
  if (!token) { token = randomCode(); fresh = true }
  const id = await digest(token)
  const row = await env.PORTAL_DB.prepare('SELECT payload FROM deployment_sessions WHERE id_hash=? AND expires_at>?').bind(id, Date.now()).first<{ payload: string }>()
  const data: DeploymentState = row ? JSON.parse(await decryptSecret(env.AUTH_SECRET, id, JSON.parse(row.payload))) : {}
  if (!row && !create) throw Object.assign(new Error('Deployment session expired'), { status: 401 })
  async function save() {
    const payload = JSON.stringify(await encryptSecret(env.AUTH_SECRET, id, JSON.stringify(data)))
    await env.PORTAL_DB.prepare('INSERT INTO deployment_sessions(id_hash,payload,expires_at) VALUES (?,?,?) ON CONFLICT(id_hash) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at').bind(id, payload, Date.now() + 3600000).run()
  }
  const cookie = fresh ? `llll_deploy=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=3600` : ''
  return { id, data, save, cookie }
}
