import { agentExecutionPolicy } from '../../../utils/agent-execution-policy'
import { requireMember } from '../../../utils/guards'
import { cf, fail } from '../../../utils/cf'
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  const actor = await requireMember(event, getRouterParam(event, 'id')!)
  if (!actor.authorization.principal.isOwner) fail(403, 'forbidden', 'Only the Server owner can inspect execution settings')
  return { policy: await agentExecutionPolicy(cf(event).env) }
})
