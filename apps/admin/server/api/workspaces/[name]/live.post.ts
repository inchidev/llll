import { adminEnv, assertMutation } from '../../../utils/http'
import { provisionLive } from '../../../utils/live'
import { requireOwner } from '../../../utils/session'
import { requireWorkspace } from '../../../utils/workspaces'

/** Create the workspace's RealtimeKit app now instead of on the first call. */
export default defineEventHandler(async (event) => {
  assertMutation(event)
  await requireOwner(event)
  const env = adminEnv(event)
  const workspace = await requireWorkspace(env, getRouterParam(event, 'name') || '')
  return provisionLive(env, workspace.workerName)
})
