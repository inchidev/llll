import type { InstallationManagementStatusDTO } from '../../../../shared/releases'
import { cf, fail } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { workspaceMailDomains } from '../../../utils/workspace-mail'
import { liveAvailable } from '../../../../workers/realtimekit'

export default defineEventHandler(async (event): Promise<InstallationManagementStatusDTO> => {
  setHeader(event, 'Cache-Control', 'no-store')
  const workspaceId = getRouterParam(event, 'id')!
  const member = await requireMember(event, workspaceId)
  if (!member.isOwner) fail(403, 'forbidden', 'Only the owner can view this server deployment')

  const { env } = cf(event)
  const accountId = env.LLLL_ACCOUNT_ID?.trim() || ''
  const workerName = env.LLLL_WORKER_NAME?.trim() || ''
  const hostname = env.LLLL_APP_HOSTNAME?.trim() || ''
  const available = Boolean(accountId && workerName && hostname)
  const emailDomains = workspaceMailDomains(env).map(item => item.domain)

  return {
    available,
    workerName: workerName || null,
    hostname: hostname || null,
    primary: env.LLLL_PRIMARY === 'true',
    customDomainEnabled: env.LLLL_CUSTOM_DOMAIN === 'true',
    liveEnabled: await liveAvailable(env),
    emailEnabled: emailDomains.length > 0,
    emailDomains,
    emailEligible: env.LLLL_PRIMARY === 'true',
  }
})
