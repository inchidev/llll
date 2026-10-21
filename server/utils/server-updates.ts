import type { H3Event } from 'h3'
import type { L4Env } from '../../workers/env'
import { decryptSecret } from '../../shared/encrypted-secret'
import { activeUpdate, changeUpdateRecord, updateHookId, type UpdateStore } from '../../shared/server-updates'
import { createUpdateStore } from '../../shared/server-update-store'
import { authSecret } from './auth-config'
import { cf, fail } from './cf'
import { requireMember } from './guards'

export function serverUpdateBuildUrl(env: L4Env, buildId: string | null | undefined) {
  if (!buildId || !/^[a-f0-9-]{36}$/i.test(buildId) || !env.LLLL_ACCOUNT_ID || !env.LLLL_WORKER_NAME) return null
  return `https://dash.cloudflare.com/${encodeURIComponent(env.LLLL_ACCOUNT_ID)}/workers/services/view/${encodeURIComponent(env.LLLL_WORKER_NAME)}/production/builds/${buildId}`
}

export async function updateOwner(event: H3Event) {
  const serverId = getRouterParam(event, 'id')!
  const member = await requireMember(event, serverId)
  if (!member.isOwner) fail(403, 'forbidden', 'Only the owner can update this Server')
  return { serverId, member, env: cf(event).env }
}

export function updateStorage(env: L4Env, _serverId: string): UpdateStore {
  if (!env.BACKUPS || !env.FILES || !env.BACKUP_BUCKET_NAME || !env.LLLL_ACCOUNT_ID || !env.LLLL_WORKER_NAME || env.LLLL_SERVER_MARKER !== 'llll.gg/server-v1' || env.LLLL_RUNTIME === 'celld') fail(409, 'updates_unavailable', 'Updates require an L4 Git-connected Cloudflare Build and a separate backup bucket. VPS operators use llll upgrade.')
  // Reads must start on the primary so a fresh request cannot miss an active Build.
  const database = env.DB.withSession('first-primary')
  return createUpdateStore(async (sql, params) => (await database.prepare(sql).bind(...params).all<{ payload: string; revision: number }>()).results)
}

export async function updateConfiguration(event: H3Event, env: L4Env, serverId: string) {
  const store = updateStorage(env, serverId)
  const { value } = await store.read()
  let hook: string | null
  try {
    hook = env.LLLL_UPDATE_HOOK?.trim() || (value.hook ? await decryptSecret(authSecret(env, getRequestURL(event).origin), `server-update-hook:${serverId}`, value.hook) : null)
    if (hook) hook = updateHookId(hook)
  } catch { hook = null /* Unreadable credentials remain private and can be replaced by the owner. */ }
  return { store, value, hook }
}

export async function triggerServerUpdate(store: UpdateStore, jobId: string, hook: string) {
  let issue: string | null = null
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/${updateHookId(hook)}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw new Error('hook rejected')
    const result = await response.json() as { success?: boolean }
    if (result.success === false) throw new Error('hook rejected')
  } catch {
    // A timeout is ambiguous: the Build may already be running. Keep the same job locked.
    issue = 'The Build start could not be confirmed. Retry starting this request; do not create another update.'
  }
  await changeUpdateRecord(store, (record) => {
    if (record.job?.id === jobId && ['queued', 'attention'].includes(record.job.stage)) {
      record.job.error = issue
      record.job.updatedAt = new Date().toISOString()
    }
  })
}

export function assertQueuedJob(value: Awaited<ReturnType<UpdateStore['read']>>['value'], id: string) {
  if (!value.job || value.job.id !== id || !activeUpdate(value.job) || value.job.stage !== 'queued') fail(409, 'update_not_queued', 'Only a queued request can be started again or cancelled')
}
