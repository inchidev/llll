import { assertMutation } from '../utils/http'
import { logout } from '../utils/session'

export default defineEventHandler(async (event) => {
  assertMutation(event)
  await logout(event)
  return { ok: true }
})
