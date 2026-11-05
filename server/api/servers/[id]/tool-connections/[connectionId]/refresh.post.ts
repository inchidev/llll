import { refreshMcpConnection } from '../../../../../utils/outbound-mcp'
import { requireMember } from '../../../../../utils/guards'
import { cf } from '../../../../../utils/cf'
export default defineEventHandler(async event => {
  const actor = await requireMember(event, getRouterParam(event, 'id')!)
  return refreshMcpConnection(cf(event).env, actor.authorization, getRouterParam(event, 'connectionId')!, getRequestURL(event).origin)
})
