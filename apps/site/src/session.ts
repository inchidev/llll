import { encryptSecret, decryptSecret } from '../../../shared/encrypted-secret'
import { randomCode, type CloudflareGrant } from '../../../shared/cloudflare-oauth'
import type { WebEnv } from './env'

export type DeploymentState = {
  state?: string; verifier?: string; grant?: CloudflareGrant
  accountId?: string; name?: string; version?: string; worker?: string; ownerEmail?: string
  setupToken?: string; origin?: string
  step?: number; error?: string; completed?: boolean
  deployments?: { accountId: string; origin: string; name: string; version: string; setupToken: string }[]
}
export function rememberDeployment(data: DeploymentState) {
  if (!data.completed || !data.accountId || !data.origin || !data.setupToken) return
  data.deployments = [{ accountId: data.accountId, origin: data.origin, name: data.name || 'L4', version: data.version || '', setupToken: data.setupToken }, ...(data.deployments || []).filter(item => item.origin !== data.origin)].slice(0, 20)
}
export function clearDeployment(data: DeploymentState) {
  rememberDeployment(data)
  for (const key of Object.keys(data)) if (!['grant', 'deployments'].includes(key)) Reflect.deleteProperty(data, key)
}
export async function digest(value: string) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, '0')).join('') }
export async function webSession(request: Request, env: WebEnv, create = false) {
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) throw Object.assign(new Error('Configure the deployment service secret (AUTH_SECRET)'), { status: 503 })
  let token = /(?:^|;\s*)llll_deploy=([a-zA-Z0-9_-]{64})(?:;|$)/.exec(request.headers.get('cookie') || '')?.[1]
  if (!token && !create) throw Object.assign(new Error('Start the deployment again'), { status: 401 })
  let fresh = false
  if (!token) { token = randomCode(); fresh = true }
  const id = await digest(token)
  const row = await env.DB.prepare('SELECT payload,expires_at FROM deployment_sessions WHERE id_hash=? AND expires_at>?').bind(id, Date.now()).first<{ payload: string; expires_at: number }>()
  const data: DeploymentState = row ? JSON.parse(await decryptSecret(env.AUTH_SECRET, id, JSON.parse(row.payload))) : {}
  if (!row && !create) throw Object.assign(new Error('Deployment session expired'), { status: 401 })
  // Only an explicit OAuth connection renews this browser session. Polling and
  // token refreshes cannot keep infrastructure access alive indefinitely.
  const expiresAt = create ? Date.now() + 3600000 : row!.expires_at
  async function save() {
    const payload = JSON.stringify(await encryptSecret(env.AUTH_SECRET, id, JSON.stringify(data)))
    await env.DB.prepare('INSERT INTO deployment_sessions(id_hash,payload,expires_at) VALUES (?,?,?) ON CONFLICT(id_hash) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at').bind(id, payload, expiresAt).run()
  }
  const cookie = fresh || create ? `llll_deploy=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=3600` : ''
  return { id, data, save, cookie, expiresAt }
}
