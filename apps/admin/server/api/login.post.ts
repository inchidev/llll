import { assertMutation } from '../utils/http'
import { login } from '../utils/session'

export default defineEventHandler(async (event) => {
  assertMutation(event)
  return login(event, await readBody(event) ?? {})
})
