import { mcpConnections } from '../../../../utils/outbound-mcp'
import { requireMember } from '../../../../utils/guards'
import { cf } from '../../../../utils/cf'
export default defineEventHandler(async event => {
  const actor = await requireMember(event, getRouterParam(event, 'id')!)
  setHeader(event, 'Cache-Control', 'no-store')
  return mcpConnections(cf(event).env, actor.authorization)
})
