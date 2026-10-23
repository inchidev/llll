import { z } from 'zod'
import { agentProviderCatalog, importOpenRouterDeployment } from '../../../../utils/agent-providers'
import { cf, fail } from '../../../../utils/cf'
import { requireMember } from '../../../../utils/guards'
import { parseBody } from '../../../../utils/validate'
import { writeAudit } from '../../../../utils/messages'
export default defineEventHandler(async event => {
  const serverId = getRouterParam(event, 'id')!
  const actor = await requireMember(event, serverId)
  if (!actor.isOwner) fail(403, 'forbidden', 'Only the owner can import credentials')
  const { webSearch } = parseBody(z.object({ webSearch: z.boolean().default(false) }), await readBody(event))
  const { env } = cf(event)
  await importOpenRouterDeployment(env, webSearch)
  await writeAudit(env, { serverId, actorId: actor.user.id, action: 'agent.provider.import', targetType: 'server', targetId: serverId, meta: { provider: 'openrouter', webSearch } })
  return agentProviderCatalog(env)
})
