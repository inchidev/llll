import { saveMcpConnection } from '../../../../utils/outbound-mcp'
import { requireMember } from '../../../../utils/guards'
import { cf } from '../../../../utils/cf'
export default defineEventHandler(async event => {
  const actor = await requireMember(event, getRouterParam(event, 'id')!)
  return { connection: await saveMcpConnection(cf(event).env, actor.authorization, await readBody(event)) }
})
