import { getServerId } from '../../../../shared/server-id'
import { z } from 'zod'
import { Permission } from '../../../../shared/permissions'
import { writeServerSetting } from '../../../../shared/server-settings'
import { agentConversationEffortKey, agentConversationModelKey } from '../../../utils/agent-conversation-model'
import { agentEfforts } from '../../../../shared/agent-providers'
import { agentProviderCatalog, catalogAgentModel } from '../../../utils/agent-providers'
import { requireChannelMember, requireMember } from '../../../utils/guards'
import { cf, fail } from '../../../utils/cf'
import { parseBody } from '../../../utils/validate'
export default defineEventHandler(async event => {
  const id = getRouterParam(event, 'id')!
  const actor = await requireMember(event, await getServerId(cf(event).env.DB), Permission.useAgents)
  await requireChannelMember(event, id)
  await requireChannelMember(event, id, Permission.sendMessages)
  const { model, effort } = parseBody(z.object({ model: z.string().min(1).max(200).optional(), effort: z.enum(agentEfforts).optional() }).refine(input => input.model || input.effort, 'Choose a model or effort'), await readBody(event))
  const { env } = cf(event)
  if (effort) await writeServerSetting(env.DB, await agentConversationEffortKey(env, id), effort)
  if (!model) return { effort }
  const selected = catalogAgentModel(env, model, await agentProviderCatalog(env, { actorId: actor.user.id }))
  if (!selected) fail(400, 'model_unavailable', 'Choose a configured model')
  await writeServerSetting(env.DB, await agentConversationModelKey(env, id), selected)
  return { selected, ...(effort ? { effort } : {}) }
})
