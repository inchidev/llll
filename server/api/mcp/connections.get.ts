import { cf } from '../../utils/cf'
import { requireUser } from '../../utils/auth'
import { listMcpConnections } from '../../utils/mcp-oauth'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const user = await requireUser(event)
  return { connections: await listMcpConnections(cf(event).env, user.id) }
})
