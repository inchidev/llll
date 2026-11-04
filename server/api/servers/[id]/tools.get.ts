import { z } from 'zod'
import { toolsSettings } from '../../../utils/agent-tools-settings'
import { requireMember } from '../../../utils/guards'
import { parseBody } from '../../../utils/validate'
import { cf } from '../../../utils/cf'
export default defineEventHandler(async event => {
  const actor = await requireMember(event, getRouterParam(event,'id')!)
  const query = parseBody(z.object({ agentId:z.string().uuid().optional() }).strict(),getQuery(event))
  setHeader(event,'Cache-Control','no-store')
  return toolsSettings(cf(event).env,actor.authorization,query.agentId)
})
