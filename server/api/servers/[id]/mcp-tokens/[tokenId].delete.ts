import { getServerId } from '../../../../../shared/server-id'
import { cf, fail } from '../../../../utils/cf'
import { requireMember } from '../../../../utils/guards'
import { revokeMcpAccessToken } from '../../../../utils/mcp-access'
import { writeAudit } from '../../../../utils/messages'

export default defineEventHandler(async (event) => {
  const serverId = getRouterParam(event, 'id')!
  const tokenId = getRouterParam(event, 'tokenId')!
  if (serverId !== (await getServerId(cf(event).env.DB))) fail(404, 'not_found', 'Server not found')
  const actor = await requireMember(event, serverId)
  if (!actor.isOwner) fail(403, 'forbidden', 'Only the server owner can manage MCP access tokens')
  const { env } = cf(event)
  if (!await revokeMcpAccessToken(env, tokenId)) fail(404, 'not_found', 'Access token not found')
  await writeAudit(env, {
    serverId,
    actorId: actor.user.id,
    action: 'mcp_token.revoke',
    targetType: 'mcp_token',
    targetId: tokenId,
  })
  return { ok: true }
})
