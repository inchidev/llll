import { z } from 'zod'
import { agentProviderPage } from '../../../../utils/agent-providers'
import { requireMember } from '../../../../utils/guards'
import { cf, fail } from '../../../../utils/cf'
import { parseBody } from '../../../../utils/validate'
export default defineEventHandler(async event => {
  const actor = await requireMember(event, getRouterParam(event, 'id')!)
  if (!actor.isOwner) fail(403, 'forbidden', 'Only the owner can manage provider connections')
  const { search, page } = parseBody(z.object({ search: z.string().max(160).default(''), page: z.coerce.number().int().min(1).max(1000000).default(1) }), getQuery(event))
  setHeader(event, 'Cache-Control', 'no-store')
  return agentProviderPage(cf(event).env, actor.user.id, search, page)
})
