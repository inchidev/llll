import type { ServerManagementStatusDTO } from '../../../../shared/releases'
import { cf, fail } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { serverMailDomains } from '../../../utils/server-mail'
import { liveAvailable } from '../../../../workers/realtimekit'

export default defineEventHandler(async (event): Promise<ServerManagementStatusDTO> => {
  setHeader(event, 'Cache-Control', 'no-store')
  const serverId = getRouterParam(event, 'id')!
  const member = await requireMember(event, serverId)
  if (!member.isOwner) fail(403, 'forbidden', 'Only the owner can view this server deployment')

  const { env } = cf(event)
  const accountId = env.LLLL_ACCOUNT_ID?.trim() || ''
  const workerName = env.LLLL_WORKER_NAME?.trim() || ''
  const hostname = env.LLLL_APP_HOSTNAME?.trim() || ''
  const available = Boolean(accountId && workerName && hostname)
  const emailDomains = serverMailDomains(env).map(item => item.domain)

  return {
    available,
    workerName: workerName || null,
    hostname: hostname || null,
    customDomainEnabled: env.LLLL_CUSTOM_DOMAIN === 'true',
    liveEnabled: await liveAvailable(env),
    emailEligible: true,
    emailEnabled: emailDomains.length > 0,
    emailDomains,
  }
})
