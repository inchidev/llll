import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { authUsers } from '../../../drizzle/schema'
import { accountEmailSchema } from '../../../shared/account'
import { addPendingEmail } from '../../utils/account-email'
import { requireUser } from '../../utils/auth'
import { authMode } from '../../utils/cloudflare-access'
import { cf, fail } from '../../utils/cf'
import { getDb } from '../../utils/db'
import { parseBody } from '../../utils/validate'
import { writeAudit } from '../../utils/messages'
import { clientIp, requireRateLimit } from '../../utils/rate-limit'
import { getServerId } from '../../../shared/server-id'

const bodySchema = z.object({ email: accountEmailSchema })

/** Adds or changes the Account's email. It counts for nothing until its link is opened. */
export default defineEventHandler(async (event): Promise<{ pendingEmail: string; confirmationSent: boolean }> => {
  const me = await requireUser(event)
  const { env } = cf(event)
  if (authMode(env) === 'access') fail(400, 'managed_by_access', 'Cloudflare Access decides the email on this Server')
  const { email } = parseBody(bodySchema, await readBody(event))
  await requireRateLimit(event, [
    { key: `ip:${clientIp(event)}:account-email`, limit: 10, windowMs: 60 * 60 * 1000 },
    { key: `account:${me.id}:account-email`, limit: 5, windowMs: 60 * 60 * 1000 },
  ], 'Too many email changes. Try again later.')
  const current = (await getDb(env.DB).select().from(authUsers).where(eq(authUsers.id, me.id)).limit(1))[0]
  if (!current) fail(404, 'not_found', 'Account not found')
  if (current.emailVerified && current.email === email) fail(400, 'already_verified', 'This email is already verified on your account')
  const confirmationSent = await addPendingEmail(event, me.id, email)
  await writeAudit(env, { serverId: await getServerId(env.DB), actorId: me.id, action: 'account.email.add', targetType: 'user', targetId: me.id, meta: { confirmationSent } })
  return { pendingEmail: email, confirmationSent }
})
