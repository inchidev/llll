import type { H3Event } from 'h3'
import type { L4Env } from '../../workers/env'
import { getServerId } from '../../shared/server-id'
import { SERVER_WORKER_NAME, readServerSetting } from '../../shared/server-settings'
import { activeUpdate, type UpdateStore } from '../../shared/server-updates'
import { createUpdateStore } from '../../shared/server-update-store'
import { cf, fail } from './cf'
import { requireMember } from './guards'

/** Where this Server's owner starts install and update flows. */
export type ServerDeployment = {
  accountId: string
  workerName: string
  site: string
  origin: string
}

export async function serverDeployment(env: L4Env, fallbackOrigin?: string): Promise<ServerDeployment | null> {
  const accountId = env.ACCOUNT_ID?.trim() || env.LLLL_ACCOUNT_ID?.trim() || ''
  if (!accountId || env.LLLL_RUNTIME?.trim().toLowerCase() === 'celld') return null
  let storedWorkerName: string | null = null
  try { storedWorkerName = await readServerSetting(env.DB, SERVER_WORKER_NAME) } catch { /* A Database stub without settings still launches. */ }
  const workerName = storedWorkerName
    || env.LLLL_WORKER_NAME?.trim()
    || `llll-${await getServerId(env.DB)}`
  const origin = fallbackOrigin?.trim() || env.PUBLIC_ORIGIN?.trim() || ''
  if (!origin) return null
  const site = env.UPDATE_SITE?.trim() || env.LLLL_UPDATE_SITE?.trim() || 'https://llll.gg'
  return { accountId, workerName, site, origin }
}

function launchUrl(base: ServerDeployment, path: string, params: Record<string, string>) {
  let url: URL
  try { url = new URL(path, base.site) } catch { return null }
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return url.toString()
}

/** The official installer performs the upload after the owner authorizes Cloudflare. */
export async function serverUpdateLaunchUrl(
  env: L4Env,
  job: { id: string } | null | undefined,
  fallbackOrigin?: string,
) {
  if (!job) return null
  const deployment = await serverDeployment(env, fallbackOrigin)
  if (!deployment) return null
  return launchUrl(deployment, '/create', {
    tab: 'cloudflare',
    server: deployment.origin,
    account: deployment.accountId,
    worker: deployment.workerName,
    update: job.id,
  })
}

/** Open the official domain flow with a single-use request token. */
export async function serverDomainLaunchUrl(
  env: L4Env,
  request: { id: string, action: string, hostname: string },
  token: string,
  options: { makePrimary?: boolean, fallbackOrigin?: string, serverId?: string } = {},
) {
  const deployment = await serverDeployment(env, options.fallbackOrigin)
  if (!deployment) return null
  const params: Record<string, string> = {
    server: deployment.origin,
    account: deployment.accountId,
    worker: deployment.workerName,
    domainRequest: request.id,
    domainToken: token,
    action: request.action,
    hostname: request.hostname,
  }
  if (options.serverId) params.serverId = options.serverId
  if (options.makePrimary) params.primary = '1'
  return launchUrl(deployment, '/domain', params)
}

export async function updateOwner(event: H3Event) {
  const serverId = getRouterParam(event, 'id')!
  const member = await requireMember(event, serverId)
  if (!member.isOwner) fail(403, 'forbidden', 'Only the owner can update this Server')
  return { serverId, member, env: cf(event).env }
}

export function updateStorage(env: L4Env, _serverId: string): UpdateStore {
  const accountId = env.ACCOUNT_ID?.trim() || env.LLLL_ACCOUNT_ID?.trim()
  if ((!env.FILES && !env.TICKETS) || !accountId || env.LLLL_RUNTIME === 'celld') fail(409, 'updates_unavailable', 'Updates require storage and a published L4 Server release. VPS operators use llll upgrade.')
  // Reads must start on the primary so a fresh request cannot miss an active Build.
  const database = env.DB.withSession('first-primary')
  return createUpdateStore(async (sql, params) => (await database.prepare(sql).bind(...params).all<{ payload: string; revision: number }>()).results)
}

export async function updateConfiguration(event: H3Event, env: L4Env, serverId: string) {
  const store = updateStorage(env, serverId)
  const { value } = await store.read()
  return { store, value }
}

export function assertQueuedJob(value: Awaited<ReturnType<UpdateStore['read']>>['value'], id: string) {
  if (!value.job || value.job.id !== id || !activeUpdate(value.job) || value.job.stage !== 'queued') fail(409, 'update_not_queued', 'Only a queued request can be started again or cancelled')
}
