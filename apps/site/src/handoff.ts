import { readL4Server } from '../../../packages/deployment-core/src/servers'
import type { DeploymentState } from './session'
import { digest } from './session'
import { queryRows } from './update'

/**
 * Hand this session's Cloudflare grant to a Server the Owner chose to keep it
 * on. The installer registers a single-use capability in the Server's own D1
 * (it already writes there over the API), then posts the grant to the Server,
 * which checks the account and encrypts it with its AUTH_SECRET. The installer
 * then forgets the grant, so only one party ever refreshes it.
 */
export async function handOffCloudflareAccess(state: DeploymentState, target: { accountId: string; origin: string; workerName: string; databaseId?: string }) {
  const grant = state.grant
  if (!grant) throw new Error('Reconnect Cloudflare to keep access on this Server')
  const databaseId = target.databaseId ?? (await readL4Server(grant.accessToken, target.accountId, target.workerName))?.resources.databaseId
  if (!databaseId) throw new Error('The Server database was not found')
  const capability = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('')
  await queryRows(grant.accessToken, target.accountId, databaseId,
    'INSERT INTO server_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',
    ['cloudflare.access.handoff', `${await digest(capability)}:${Date.now() + 600000}`, new Date().toISOString()])
  const response = await fetch(new URL('/api/cloudflare-account/handoff', target.origin), {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${capability}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant, accountId: target.accountId }),
  })
  if (!response.ok) {
    const detail = await response.json().catch(() => null) as { error?: { message?: string } } | null
    throw new Error(detail?.error?.message || `The Server did not accept Cloudflare access (${response.status})`)
  }
  delete state.grant
}
