import { adminEnv, assertMutation } from '../../utils/http'
import { setAutomaticUpdates } from '../../utils/releases'
import { requireOwner } from '../../utils/session'

export default defineEventHandler(async (event) => {
  assertMutation(event)
  await requireOwner(event)
  const body = await readBody<{ automaticUpdates?: { admin?: unknown, workspaces?: unknown } }>(event)
  const value = { admin: body?.automaticUpdates?.admin !== false, workspaces: body?.automaticUpdates?.workspaces === true }
  await setAutomaticUpdates(adminEnv(event), value)
  return { automaticUpdates: value }
})
