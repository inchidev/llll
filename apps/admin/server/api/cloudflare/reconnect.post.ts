import { startReconnect } from '../../utils/credential'
import { adminEnv, assertMutation } from '../../utils/http'
import { requireOwner } from '../../utils/session'

export default defineEventHandler(async (event) => {
  assertMutation(event)
  await requireOwner(event)
  return { url: await startReconnect(adminEnv(event), getRequestURL(event).origin) }
})
