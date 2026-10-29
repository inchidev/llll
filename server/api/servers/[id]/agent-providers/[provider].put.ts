import { agentConnectionId, agentProviderSchema } from '../../../../../shared/agent-providers'
import { loadAgentProvider, providerDTO, saveAgentProvider } from '../../../../utils/agent-providers'
import { cf, fail } from '../../../../utils/cf'
import { requireMember } from '../../../../utils/guards'
import { parseBody } from '../../../../utils/validate'
import { writeAudit } from '../../../../utils/messages'
export default defineEventHandler(async event => {
  const serverId = getRouterParam(event, 'id')!
  const actor = await requireMember(event, serverId)
  if (!actor.isOwner) fail(403, 'forbidden', 'Only the owner can manage provider credentials')
  const provider = parseBody(agentConnectionId, getRouterParam(event, 'provider'))
  const input = parseBody(agentProviderSchema, await readBody(event))
  const { env } = cf(event)
  await saveAgentProvider(env, provider, input, actor.user.id)
  await writeAudit(env, { serverId, actorId: actor.user.id, action: 'agent.provider.update', targetType: 'server', targetId: serverId, meta: { provider, enabled: input.enabled, keyReplaced: Boolean(input.apiKey), ...(input.shared !== undefined ? { shared: input.shared } : {}) } })
  setHeader(event, 'Cache-Control', 'no-store')
  return { provider: await providerDTO(env, provider, (await loadAgentProvider(env, provider))!, { owner: true, actorId: actor.user.id }) }
})
