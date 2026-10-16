import { adminEnv, assertMutation, progressStream } from '../../../utils/http'
import { requireOwner } from '../../../utils/session'
import { updateWorkspace } from '../../../utils/workspaces'

export default defineEventHandler(async (event) => {
  assertMutation(event)
  await requireOwner(event)
  const env = adminEnv(event)
  const workerName = getRouterParam(event, 'name') || ''
  return progressStream(event, report => updateWorkspace(env, workerName, report))
})
