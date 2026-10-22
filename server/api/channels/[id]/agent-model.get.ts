import { getServerId } from '../../../../shared/server-id'
import { Permission } from '../../../../shared/permissions'
import { agentConversationModel } from '../../../utils/agent-conversation-model'
import { agentProviderCatalog } from '../../../utils/agent-providers'
import { requireChannelMember, requireMember } from '../../../utils/guards'
import { cf } from '../../../utils/cf'
export default defineEventHandler(async event => {
  const id = getRouterParam(event, 'id')!
  await requireMember(event, await getServerId(cf(event).env.DB), Permission.useAgents)
  await requireChannelMember(event, id)
  const { env } = cf(event)
  const catalog = await agentProviderCatalog(env)
  const selected = await agentConversationModel(env, id)
  setHeader(event, 'Cache-Control', 'no-store')
  const active = await env.DB.prepare("SELECT agent_id as agentId,status FROM agent_runs WHERE (channel_id=? OR channel_id IN (SELECT id FROM channels WHERE parent_id=?)) AND status IN ('queued','running') ORDER BY created_at LIMIT 100")
    .bind(id, id).all<{ agentId: string; status: string }>()
  return { ...catalog, active: active.results, selected: selected ?? catalog.defaultModel }
})
