import { agentConnectionId } from '../../../../../shared/agent-providers'
import { loadAgentProvider, providerDTO } from '../../../../utils/agent-providers'
import { requireMember } from '../../../../utils/guards'
import { cf, fail } from '../../../../utils/cf'
import { parseBody } from '../../../../utils/validate'
export default defineEventHandler(async event => {
  const actor = await requireMember(event, getRouterParam(event, 'id')!)
  if (!actor.isOwner) fail(403, 'forbidden', 'Only the owner can inspect a provider connection')
  const id = parseBody(agentConnectionId, getRouterParam(event, 'provider'))
  const { env } = cf(event)
  const saved = await loadAgentProvider(env, id)
  const provider = saved ? await providerDTO(env, id, saved, { owner: true, actorId: actor.user.id }) : null
  if (!provider) fail(404, 'not_found', 'Provider connection not found')
  setHeader(event, 'Cache-Control', 'no-store')
  return { provider }
})
