import { agentConnectionId } from '../../../../../shared/agent-providers'
import { loadAgentProvider, providerDTO } from '../../../../utils/agent-providers'
import { providerManager } from '../../../../utils/agent-provider-access'
import { cf, fail } from '../../../../utils/cf'
import { parseBody } from '../../../../utils/validate'
export default defineEventHandler(async event => {
  const manager = await providerManager(event), actor = manager.actor
  const id = parseBody(agentConnectionId, getRouterParam(event, 'provider'))
  const { env } = cf(event)
  const saved = await loadAgentProvider(env, id)
  if (saved) manager.require(saved.kind, saved)
  const provider = saved ? await providerDTO(env, id, saved, { owner: true, actorId: actor.user.id }) : null
  if (!provider) fail(404, 'not_found', 'Provider connection not found')
  setHeader(event, 'Cache-Control', 'no-store')
  return { provider }
})
