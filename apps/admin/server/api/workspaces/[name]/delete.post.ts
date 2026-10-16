import { adminEnv, assertMutation } from '../../../utils/http'
import { requireOwner } from '../../../utils/session'
import { deleteWorkspace } from '../../../utils/workspaces'

export default defineEventHandler(async (event) => {
  assertMutation(event)
  await requireOwner(event)
  const body = await readBody<{ claim?: unknown, confirmation?: unknown }>(event) ?? {}
  return deleteWorkspace(adminEnv(event), getRouterParam(event, 'name') || '', body)
})
