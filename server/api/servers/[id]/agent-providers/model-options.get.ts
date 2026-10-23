import { Permission } from '../../../../../shared/permissions'
import { agentModelOptions } from '../../../../utils/agent-model-options'
import { requireMember } from '../../../../utils/guards'
import { cf } from '../../../../utils/cf'
export default defineEventHandler(async event => {
  const actor = await requireMember(event, getRouterParam(event, 'id')!, Permission.useAgents)
  const query = getQuery(event)
  setHeader(event, 'Cache-Control', 'no-store')
  return agentModelOptions(cf(event).env, actor.user.id, String(query.search ?? '').slice(0, 160), typeof query.selected === 'string' ? query.selected : null)
})
