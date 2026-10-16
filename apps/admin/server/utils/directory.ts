import type { AdminEnv } from '../env'
import { credentialStatus } from './credential'
import { readMeta } from './db'
import type { WorkspaceSummary } from './workspaces'

/**
 * Tell the L4 Account that created this Admin that it is alive. The
 * directory only lists Admins; it has no way to reach into the account.
 */
export async function sendHeartbeat(env: AdminEnv, workspaces: WorkspaceSummary[] | null) {
  const endpoint = env.LLLL_DIRECTORY_ENDPOINT?.trim()
  const id = env.LLLL_DIRECTORY_ID?.trim()
  const token = env.LLLL_DIRECTORY_TOKEN?.trim()
  if (!endpoint || !id || !token) return 'unconfigured' as const
  const credential = await credentialStatus(env)
  const response = await fetch(`${endpoint.replace(/\/$/u, '')}/heartbeat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id,
      version: env.LLLL_VERSION || null,
      origin: await readMeta(env.ADMIN_DB, 'origin'),
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      connected: credential.connected,
      workspaces: workspaces?.map(workspace => ({
        workerName: workspace.workerName,
        appName: workspace.appName,
        origin: workspace.origin,
        version: workspace.version,
      })) ?? null,
    }),
  })
  if (!response.ok) throw new Error(`Directory heartbeat returned ${response.status}`)
  return 'sent' as const
}
