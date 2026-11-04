import type { AgentAccessMode } from '../../../../../../shared/agent-access'
import { setAgentAccessMode } from '../../../../../utils/agent-access'
import { requireManagedAgent } from '../../../../../utils/agent-webhook-access'
import { cf } from '../../../../../utils/cf'

export default defineEventHandler(async (event): Promise<{ access: AgentAccessMode }> => {
  const { agentId, actor } = await requireManagedAgent(event)
  return { access: await setAgentAccessMode(cf(event).env, actor.authorization, agentId, await readBody(event)) }
})
