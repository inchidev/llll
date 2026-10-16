import { adminEnv, assertMutation } from '../../utils/http'
import { requireOwner } from '../../utils/session'
import { limitRecovery, rotateRecoveryCodes } from '../../utils/recovery'

export default defineEventHandler(async (event) => {
  assertMutation(event)
  const owner = await requireOwner(event)
  setHeader(event, 'Cache-Control', 'no-store')
  const db = adminEnv(event).ADMIN_DB
  await limitRecovery(db, `rotate:${owner.id}`)
  const body = await readBody(event) ?? {}
  return { codes: await rotateRecoveryCodes(db, owner.id, body.password) }
})
