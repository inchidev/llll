import { getServerId } from '../../../../shared/server-id'
import { cf, fail } from '../../../utils/cf'
import { requireUser } from '../../../utils/auth'
import { revokeMcpConnection } from '../../../utils/mcp-oauth'
import { writeAudit } from '../../../utils/messages'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const { env } = cf(event)
  const id = getRouterParam(event, 'id')!
  if (!await revokeMcpConnection(env, id, user.id)) fail(404, 'not_found', 'Connection not found')
  await writeAudit(env, { serverId: await getServerId(env.DB), actorId: user.id, action: 'mcp_connection.revoke', targetType: 'mcp_connection', targetId: id })
  return { ok: true }
})
