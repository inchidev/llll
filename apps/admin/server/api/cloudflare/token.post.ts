import { usePastedToken } from '../../utils/credential'
import { adminEnv, assertMutation } from '../../utils/http'
import { requireOwner } from '../../utils/session'

export default defineEventHandler(async (event) => {
  assertMutation(event)
  await requireOwner(event)
  const body = await readBody<{ token?: unknown }>(event)
  await usePastedToken(adminEnv(event), typeof body?.token === 'string' ? body.token : '')
  return { connected: true }
})
