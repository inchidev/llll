import { getServerId } from '../../../../../shared/server-id'
import { spaceSql } from '../../../../../shared/spaces'
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
  const outside = await env.DB.prepare(`SELECT 1 AS found FROM mcp_access_tokens t WHERE t.id = ?
    AND EXISTS (SELECT 1 FROM space_members m WHERE m.user_id = COALESCE(t.subject_id, t.created_by))
    AND NOT EXISTS (SELECT 1 FROM space_members m WHERE m.user_id = COALESCE(t.subject_id, t.created_by) AND m.space_id IN (${spaceSql(actor.authorization)}))`).bind(tokenId).first()
  if (outside) fail(404, 'not_found', 'Access token not found')
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
