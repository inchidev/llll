import { assertMutation } from '../utils/http'
import { claimOwner } from '../utils/session'

export default defineEventHandler(async (event) => {
  assertMutation(event)
  setHeader(event, 'Cache-Control', 'no-store')
  return claimOwner(event, await readBody(event) ?? {})
})
