import { adminEnv, assertMutation } from '../../../utils/http'
import { requireOwner } from '../../../utils/session'
import { linkWorkspace } from '../../../utils/workspaces'

export default defineEventHandler(async (event) => {
  assertMutation(event)
  await requireOwner(event)
  return linkWorkspace(adminEnv(event), getRouterParam(event, 'name') || '')
})
