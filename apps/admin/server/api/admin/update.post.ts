import { adminEnv, assertMutation, progressStream } from '../../utils/http'
import { updateAdmin } from '../../utils/releases'
import { requireOwner } from '../../utils/session'

export default defineEventHandler(async (event) => {
  assertMutation(event)
  await requireOwner(event)
  const env = adminEnv(event)
  return progressStream(event, report => updateAdmin(env, report))
})
