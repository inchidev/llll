import { z } from 'zod'
import { agentAuditPage } from '../../../utils/agent-audit'
import { requireMember } from '../../../utils/guards'
import { cf, fail } from '../../../utils/cf'
import { parseBody } from '../../../utils/validate'
export default defineEventHandler(async event => {
  const actor = await requireMember(event, getRouterParam(event, 'id')!)
  if (!actor.isOwner) fail(403, 'forbidden', 'Only the Server owner can read agent audit records')
  const { view, search, page } = parseBody(z.object({ view: z.enum(['runs', 'changes']).default('runs'), search: z.string().max(160).default(''), page: z.coerce.number().int().min(1).max(1000000).default(1) }), getQuery(event))
  setHeader(event, 'Cache-Control', 'no-store')
  return agentAuditPage(cf(event).env, view, search, page)
})
