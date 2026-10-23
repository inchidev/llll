import { z } from 'zod'
import { agentProviderCatalog, saveAgentProvider } from '../../../../utils/agent-providers'
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
  if (!(await agentProviderCatalog(env)).canImportOpenRouter) fail(409, 'import_unavailable', 'No OpenRouter deployment credential is available to import')
  await saveAgentProvider(env, 'openrouter', { enabled: true, webSearch, apiKey: env.AI_API_KEY!.trim(), models: [{ id: env.AI_MODEL!.trim(), api: 'chat' }] })
  await writeAudit(env, { serverId, actorId: actor.user.id, action: 'agent.provider.import', targetType: 'server', targetId: serverId, meta: { provider: 'openrouter', webSearch } })
  return agentProviderCatalog(env)
})
