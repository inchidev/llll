import { adminEnv } from '../utils/http'
import { requireOwner } from '../utils/session'
import { listWorkspaces } from '../utils/workspaces'

export default defineEventHandler(async (event) => {
  await requireOwner(event)
  setHeader(event, 'Cache-Control', 'no-store')
  return { workspaces: await listWorkspaces(adminEnv(event)) }
})
