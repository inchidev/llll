import { z } from 'zod'
import { WORKSPACE_ID } from '../../../../shared/ids'
import { MCP_SCOPES } from '../../../../shared/mcp'
import { cf, fail } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { issueMcpAccessToken } from '../../../utils/mcp-access'
import { writeAudit } from '../../../utils/messages'
import { parseBody } from '../../../utils/validate'

const bodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  subjectId: z.string().min(1).optional(),
  scopes: z.array(z.enum(MCP_SCOPES)).min(1).max(MCP_SCOPES.length).optional(),
})

export default defineEventHandler(async (event) => {
  const workspaceId = getRouterParam(event, 'id')!
  if (workspaceId !== WORKSPACE_ID) fail(404, 'not_found', 'Workspace not found')
  const actor = await requireMember(event, workspaceId)
  if (!actor.isOwner) fail(403, 'forbidden', 'Only the workspace owner can manage MCP access tokens')
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  const token = await issueMcpAccessToken(env, {
    createdBy: actor.user.id,
    subjectId: body.subjectId ?? actor.user.id,
    name: body.name,
    scopes: body.scopes ?? [...MCP_SCOPES],
  })
  await writeAudit(env, {
    workspaceId,
    actorId: actor.user.id,
    action: 'mcp_token.create',
    targetType: 'mcp_token',
    targetId: token.id,
    meta: { name: token.name, scopes: token.scopes, subjectId: token.subject.id },
  })
  setResponseHeader(event, 'Cache-Control', 'no-store')
  return { token }
})
