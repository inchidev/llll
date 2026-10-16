import { adminEnv, assertMutation } from '../../../utils/http'
import { requireOwner } from '../../../utils/session'
import { reissueOwnerSetup } from '../../../utils/workspaces'

export default defineEventHandler(async (event) => {
  assertMutation(event)
  await requireOwner(event)
  return reissueOwnerSetup(adminEnv(event), getRouterParam(event, 'name') || '')
})
