import { z } from 'zod'
import { getServerId } from '../../../shared/server-id'
import { cf } from '../../utils/cf'
import { requireMember } from '../../utils/guards'
import { readMcpConsent } from '../../utils/mcp-consent'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const query = z.object({ oauth_query: z.string().max(16_384) }).parse(getQuery(event))
  const actor = await requireMember(event, await getServerId(cf(event).env.DB))
  return readMcpConsent(event, query.oauth_query, actor.user.id)
})
