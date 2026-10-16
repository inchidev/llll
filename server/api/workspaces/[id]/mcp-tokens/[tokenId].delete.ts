import { WORKSPACE_ID } from '../../../../../shared/ids'
import { cf, fail } from '../../../../utils/cf'
import { requireMember } from '../../../../utils/guards'
import { revokeMcpAccessToken } from '../../../../utils/mcp-access'
import { writeAudit } from '../../../../utils/messages'

export default defineEventHandler(async (event) => {
  const workspaceId = getRouterParam(event, 'id')!
  const tokenId = getRouterParam(event, 'tokenId')!
  if (workspaceId !== WORKSPACE_ID) fail(404, 'not_found', 'Workspace not found')
  const actor = await requireMember(event, workspaceId)
  if (!actor.isOwner) fail(403, 'forbidden', 'Only the workspace owner can manage MCP access tokens')
  const { env } = cf(event)
  if (!await revokeMcpAccessToken(env, tokenId)) fail(404, 'not_found', 'Access token not found')
  await writeAudit(env, {
    workspaceId,
    actorId: actor.user.id,
    action: 'mcp_token.revoke',
    targetType: 'mcp_token',
    targetId: tokenId,
  })
  return { ok: true }
})
