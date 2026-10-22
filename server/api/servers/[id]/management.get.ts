import type { ServerManagementStatusDTO } from '../../../../shared/releases'
import { cf, fail } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { readServerMailDomains } from '../../../utils/server-mail'
import { getServerId } from '../../../../shared/server-id'
import { SERVER_WORKER_NAME, readServerSetting } from '../../../../shared/server-settings'
import { liveAvailable } from '../../../../workers/realtimekit'

export default defineEventHandler(async (event): Promise<ServerManagementStatusDTO> => {
  setHeader(event, 'Cache-Control', 'no-store')
  const serverId = getRouterParam(event, 'id')!
  const member = await requireMember(event, serverId)
  if (!member.isOwner) fail(403, 'forbidden', 'Only the owner can view this server deployment')

  const { env } = cf(event)
  const identityId = await getServerId(env.DB)
  const accountId = env.ACCOUNT_ID?.trim() || env.LLLL_ACCOUNT_ID?.trim() || ''
  const workerName = await readServerSetting(env.DB, SERVER_WORKER_NAME) || `llll-${identityId}`
  let hostname = ''
  try { hostname = new URL(env.PUBLIC_ORIGIN || '').hostname } catch { /* Missing origin. */ }
  const available = Boolean(accountId && workerName && hostname)
  const emailDomains = (await readServerMailDomains(env)).map(item => item.domain)

  return {
    available,
    workerName: workerName || null,
    hostname: hostname || null,
    customDomainEnabled: false,
    liveEnabled: await liveAvailable(env),
    emailEligible: true,
    emailEnabled: emailDomains.length > 0,
    emailDomains,
  }
})
