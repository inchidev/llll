import { requireUser } from '../../utils/auth'
import { cf } from '../../utils/cf'
import { canConfigurePush, loadPushKeys } from '../../../workers/push-keys'

export default defineEventHandler(async (event) => {
  await requireUser(event)
  const { env } = cf(event)
  const keys = await loadPushKeys(env)
  return { configured: canConfigurePush(env), publicKey: keys?.publicKey ?? null }
})
