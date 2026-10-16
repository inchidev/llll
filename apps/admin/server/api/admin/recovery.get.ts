import { adminEnv } from '../../utils/http'
import { requireOwner } from '../../utils/session'
import { recoveryCodeCount } from '../../utils/recovery'

export default defineEventHandler(async (event) => {
  const owner = await requireOwner(event)
  setHeader(event, 'Cache-Control', 'no-store')
  return { remaining: await recoveryCodeCount(adminEnv(event).ADMIN_DB, owner.id) }
})
