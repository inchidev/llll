import { getServerId } from '../../../../shared/server-id'
import { Permission } from '../../../../shared/permissions'
import { agentConversationModel } from '../../../utils/agent-conversation-model'
import { agentModelOptions } from '../../../utils/agent-model-options'
import { requireChannelMember, requireMember } from '../../../utils/guards'
import { cf } from '../../../utils/cf'
export default defineEventHandler(async event => {
  const id = getRouterParam(event, 'id')!
  const actor = await requireMember(event, await getServerId(cf(event).env.DB), Permission.useAgents)
  await requireChannelMember(event, id)
  const { env } = cf(event)
  const selected = await agentConversationModel(env, id)
  const catalog = await agentModelOptions(env, actor.user.id, String(getQuery(event).search ?? '').slice(0, 160), selected)
  setHeader(event, 'Cache-Control', 'no-store')
  const active = await env.DB.prepare("SELECT id,channel_id as channelId,initiated_by as initiatedBy,prompt,agent_id as agentId,status FROM agent_runs WHERE (channel_id=? OR channel_id IN (SELECT id FROM channels WHERE parent_id=?)) AND status IN ('queued','running') ORDER BY created_at LIMIT 100")
    .bind(id, id).all<{ id: string; channelId: string; initiatedBy: string; prompt: string; agentId: string; status: string }>()
  return { ...catalog, active: active.results, selected: selected ?? catalog.defaultModel }
})
