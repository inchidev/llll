import { z } from 'zod'
import { agentProviderCatalog } from '../../../../utils/agent-providers'
import { writeServerSetting } from '../../../../../shared/server-settings'
import { cf, fail } from '../../../../utils/cf'
import { requireMember } from '../../../../utils/guards'
import { parseBody } from '../../../../utils/validate'
export default defineEventHandler(async event => {
  const actor = await requireMember(event, getRouterParam(event, 'id')!)
  if (!actor.isOwner) fail(403, 'forbidden', 'Only the owner can change the default provider')
  const { model } = parseBody(z.object({ model: z.string().max(200) }), await readBody(event))
  const { env } = cf(event)
  if (model && !(await agentProviderCatalog(env, { actorId: actor.user.id })).models.some(item => item.value === model)) fail(400, 'model_unavailable', 'Choose a configured model')
  await writeServerSetting(env.DB, 'agents.defaultModel', model)
  return agentProviderCatalog(env)
})
