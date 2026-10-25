import { deleteMcpConnection } from '../../../../utils/outbound-mcp'
import { requireMember } from '../../../../utils/guards'
import { cf } from '../../../../utils/cf'
export default defineEventHandler(async event => {
  const actor = await requireMember(event, getRouterParam(event, 'id')!)
  await deleteMcpConnection(cf(event).env, actor.authorization, getRouterParam(event, 'connectionId')!)
  return { ok: true }
})
