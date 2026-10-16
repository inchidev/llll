import { requireUser } from '../../utils/auth'
import { cf } from '../../utils/cf'
import { pushConfigured } from '../../../workers/push'

export default defineEventHandler(async (event) => {
  await requireUser(event)
  const { env } = cf(event)
  return {
    configured: pushConfigured(env),
    publicKey: pushConfigured(env) ? env.VAPID_PUBLIC_KEY!.trim() : null,
  }
})
