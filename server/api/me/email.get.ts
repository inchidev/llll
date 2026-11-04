import { eq } from 'drizzle-orm'
import { authUsers } from '../../../drizzle/schema'
import type { AccountEmailStatus } from '../../../shared/types'
import { accountEmail } from '../../utils/account-identity'
import { requireUser } from '../../utils/auth'
import { loadAuthRuntimeConfig } from '../../utils/auth-config'
import { authRequestContext } from '../../utils/better-auth'
import { cf, fail } from '../../utils/cf'
import { getDb } from '../../utils/db'

export default defineEventHandler(async (event): Promise<AccountEmailStatus> => {
  setHeader(event, 'Cache-Control', 'no-store')
  const me = await requireUser(event)
  const { env } = cf(event)
  const row = (await getDb(env.DB).select().from(authUsers).where(eq(authUsers.id, me.id)).limit(1))[0]
  if (!row) fail(404, 'not_found', 'Account not found')
  const config = await loadAuthRuntimeConfig(env, (await authRequestContext(event)).baseURL)
  return {
    email: accountEmail(row),
    emailVerified: Boolean(accountEmail(row) && row.emailVerified),
    pendingEmail: row.pendingEmail,
    mailReady: config.email.verificationReady,
    managedByAccess: config.mode === 'access',
  }
})
