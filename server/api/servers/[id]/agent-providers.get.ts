import { Permission } from '../../../../shared/permissions'
import { agentProviderCatalog } from '../../../utils/agent-providers'
import { cf } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
export default defineEventHandler(async event => {
  await requireMember(event, getRouterParam(event, 'id')!, Permission.useAgents)
  setHeader(event, 'Cache-Control', 'no-store')
  return agentProviderCatalog(cf(event).env)
})
