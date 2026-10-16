import { adminEnv, assertMutation } from '../utils/http'
import { limitRecovery, recoverPassword } from '../utils/recovery'

export default defineEventHandler(async (event) => {
  assertMutation(event)
  setHeader(event, 'Cache-Control', 'no-store')
  const db = adminEnv(event).ADMIN_DB
  await limitRecovery(db, getHeader(event, 'cf-connecting-ip') || 'local')
  const result = await recoverPassword(db, await readBody(event) ?? {})
  deleteCookie(event, 'llll_admin', { path: '/' })
  return result
})
