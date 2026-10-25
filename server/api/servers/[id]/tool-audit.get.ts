import { z } from 'zod'
import { toolAudit } from '../../../utils/agent-tools-settings'
import { requireMember } from '../../../utils/guards'
import { parseBody } from '../../../utils/validate'
import { cf } from '../../../utils/cf'
export default defineEventHandler(async event => {
  const actor=await requireMember(event,getRouterParam(event,'id')!)
  const query=parseBody(z.object({search:z.string().max(160).default(''),page:z.coerce.number().int().min(1).max(1000000).default(1)}).strict(),getQuery(event))
  setHeader(event,'Cache-Control','no-store')
  return toolAudit(cf(event).env,actor.authorization,query.search,query.page)
})
