import { agentProviderIds, agentProviderSchema, type AgentProviderId } from '../../../../../shared/agent-providers'
import { agentProviderCatalog, saveAgentProvider } from '../../../../utils/agent-providers'
import { cf, fail } from '../../../../utils/cf'
import { requireMember } from '../../../../utils/guards'
import { parseBody } from '../../../../utils/validate'
import { writeAudit } from '../../../../utils/messages'
export default defineEventHandler(async event => {
  const serverId = getRouterParam(event, 'id')!
  const actor = await requireMember(event, serverId)
  if (!actor.isOwner) fail(403, 'forbidden', 'Only the owner can manage provider credentials')
  const provider = getRouterParam(event, 'provider') as AgentProviderId
  if (!agentProviderIds.includes(provider)) fail(404, 'not_found', 'Provider not found')
  const input = parseBody(agentProviderSchema, await readBody(event))
  const { env } = cf(event)
  await saveAgentProvider(env, provider, input)
  await writeAudit(env, { serverId, actorId: actor.user.id, action: 'agent.provider.update', targetType: 'server', targetId: serverId, meta: { provider, enabled: input.enabled, keyReplaced: Boolean(input.apiKey) } })
  setHeader(event, 'Cache-Control', 'no-store')
  return agentProviderCatalog(env)
})
