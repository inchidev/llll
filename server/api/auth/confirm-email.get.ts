import { confirmPendingEmail } from '../../utils/account-email'
import { ensureMigrated } from '../../utils/db'
import { cf } from '../../utils/cf'

/** Opened from the emailed link. It proves the address and nothing else: it does not sign anyone in. */
export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  await ensureMigrated(cf(event).env.DB, cf(event).env)
  const token = getQuery(event).token
  const result = typeof token === 'string' && token ? await confirmPendingEmail(event, token) : 'invalid'
  return sendRedirect(event, result === 'confirmed' ? '/login?verified=1' : `/login?verify_error=${result}`)
})
