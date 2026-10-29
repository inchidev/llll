import { requireUser } from '../../utils/auth'
import { cf, fail } from '../../utils/cf'
import { ensurePushKeys } from '../../../workers/push-keys'

export default defineEventHandler(async (event) => {
  await requireUser(event)
  const keys = await ensurePushKeys(cf(event).env)
  if (!keys) fail(503, 'push_unconfigured', 'Web Push is not configured')
  return { configured: true, publicKey: keys.publicKey }
})
