import { getServerId } from '../../../../shared/server-id'
import { z } from 'zod'
import { Permission } from '../../../../shared/permissions'
import { writeServerSetting } from '../../../../shared/server-settings'
import { agentConversationModelKey } from '../../../utils/agent-conversation-model'
import { agentProviderCatalog } from '../../../utils/agent-providers'
import { requireChannelMember, requireMember } from '../../../utils/guards'
import { cf, fail } from '../../../utils/cf'
import { parseBody } from '../../../utils/validate'
export default defineEventHandler(async event => {
  const id = getRouterParam(event, 'id')!
  await requireMember(event, await getServerId(cf(event).env.DB), Permission.useAgents)
  await requireChannelMember(event, id)
  await requireChannelMember(event, id, Permission.sendMessages)
  const { model } = parseBody(z.object({ model: z.string().min(1).max(200) }), await readBody(event))
  const { env } = cf(event)
  if (!(await agentProviderCatalog(env)).models.some(m => m.value === model)) fail(400, 'model_unavailable', 'Choose a configured model')
  await writeServerSetting(env.DB, await agentConversationModelKey(env, id), model)
  return { selected: model }
})
