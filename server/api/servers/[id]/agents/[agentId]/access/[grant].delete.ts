import { revokeAgentAccess } from '../../../../../../utils/agent-access'
import { requireManagedAgent } from '../../../../../../utils/agent-webhook-access'
import { cf } from '../../../../../../utils/cf'

export default defineEventHandler(async (event): Promise<{ ok: true }> => {
  const { agentId, actor } = await requireManagedAgent(event)
  await revokeAgentAccess(cf(event).env, actor.authorization, agentId, getRouterParam(event, 'grant')!)
  return { ok: true }
})
