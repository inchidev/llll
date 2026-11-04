import { requireMember } from '../../../../utils/guards'
import { cf, fail } from '../../../../utils/cf'
import { deploymentProviderState } from '../../../../utils/agent-deployment-provider'

export default defineEventHandler(async event => {
  const member = await requireMember(event, getRouterParam(event, 'id')!)
  if (!member.isOwner) fail(403, 'forbidden', 'Only the owner can configure model providers')
  return deploymentProviderState(cf(event).env)
})
