import type { AgentAccessDTO } from '../../../../../../shared/agent-access'
import type { ProjectPolicy } from '../../../../../../shared/project-access'
import { listAgentAccess } from '../../../../../utils/agent-access'
import { requireManagedAgent } from '../../../../../utils/agent-webhook-access'
import { listProjectPolicies } from '../../../../../utils/project-policies'
import { cf } from '../../../../../utils/cf'

export default defineEventHandler(async (event): Promise<AgentAccessDTO & { policies: ProjectPolicy[] }> => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  const { agentId, actor } = await requireManagedAgent(event)
  const { env } = cf(event)
  return { ...await listAgentAccess(env, actor.authorization, agentId), policies: await listProjectPolicies(env) }
})
