import { getServerId } from '../../../../shared/server-id'
import { spaceSql } from '../../../../shared/spaces'
import { cf, fail } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { listMcpAccessTokens } from '../../../utils/mcp-access'

export default defineEventHandler(async (event) => {
  const serverId = getRouterParam(event, 'id')!
  if (serverId !== (await getServerId(cf(event).env.DB))) fail(404, 'not_found', 'Server not found')
  const actor = await requireMember(event, serverId)
  if (!actor.isOwner) fail(403, 'forbidden', 'Only the server owner can manage MCP access tokens')
  setResponseHeader(event, 'Cache-Control', 'no-store')
  const { env } = cf(event)
  // Someone whose every Space is out of reach is hidden; a removed Member has none and their token stays revocable.
  const outside = await env.DB.prepare(`SELECT user_id AS id FROM space_members GROUP BY user_id HAVING SUM(space_id IN (${spaceSql(actor.authorization)})) = 0`).all<{ id: string }>()
  const hidden = new Set((outside.results ?? []).map(row => row.id))
  return { tokens: (await listMcpAccessTokens(env)).filter(token => !hidden.has(token.subject.id)) }
})
