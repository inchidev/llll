import type { AgentAccessGrant } from '../../../../../../shared/agent-access'
import { grantAgentAccess } from '../../../../../utils/agent-access'
import { requireManagedAgent } from '../../../../../utils/agent-webhook-access'
import { cf } from '../../../../../utils/cf'

export default defineEventHandler(async (event): Promise<{ grant: AgentAccessGrant }> => {
  const { agentId, actor } = await requireManagedAgent(event)
  return { grant: await grantAgentAccess(cf(event).env, actor.authorization, agentId, await readBody(event)) }
})
