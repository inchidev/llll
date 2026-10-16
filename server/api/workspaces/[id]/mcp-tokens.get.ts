import { WORKSPACE_ID } from '../../../../shared/ids'
import { cf, fail } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { listMcpAccessTokens } from '../../../utils/mcp-access'

export default defineEventHandler(async (event) => {
  const workspaceId = getRouterParam(event, 'id')!
  if (workspaceId !== WORKSPACE_ID) fail(404, 'not_found', 'Workspace not found')
  const actor = await requireMember(event, workspaceId)
  if (!actor.isOwner) fail(403, 'forbidden', 'Only the workspace owner can manage MCP access tokens')
  setResponseHeader(event, 'Cache-Control', 'no-store')
  return { tokens: await listMcpAccessTokens(cf(event).env) }
})
