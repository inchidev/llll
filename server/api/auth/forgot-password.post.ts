import { z } from 'zod'
import { loginSchema } from '../../../shared/account'
import { findAccountByLogin, verifiedEmail } from '../../utils/account-identity'
import { loadAuthRuntimeConfig, publicAuthConfig } from '../../utils/auth-config'
import { authFromEvent, authRequestContext } from '../../utils/better-auth'
import { cf, fail } from '../../utils/cf'
import { ensureMigrated, getDb } from '../../utils/db'
import { parseBody } from '../../utils/validate'
import { clientIp, requireRateLimit } from '../../utils/rate-limit'

const bodySchema = z.object({ login: loginSchema })

export default defineEventHandler(async (event) => {
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  await ensureMigrated(env.DB, env)
  const authContext = await authRequestContext(event)
  const runtime = await loadAuthRuntimeConfig(env, authContext.baseURL)
  if (!publicAuthConfig(runtime).passwordResetEnabled) {
    fail(503, 'password_reset_unavailable', 'This Server cannot send email. Ask the Owner for a password reset link.')
  }

  // The account budget stops reset mail from being sent to one address over and over.
  await requireRateLimit(event, [
    { key: `ip:${clientIp(event)}:password-reset`, limit: 5, windowMs: 60 * 60 * 1000 },
    { key: `account:${body.login}:password-reset`, limit: 3, windowMs: 60 * 60 * 1000 },
  ], 'Too many password reset attempts')

  // Same answer either way: only a verified address gets mail, and nobody learns who has one.
  const account = await findAccountByLogin(getDb(env.DB), body.login)
  const to = account && verifiedEmail(account)
  if (to) {
    const auth = await authFromEvent(event)
    await auth.api.requestPasswordReset({
      headers: event.headers,
      body: { email: to, redirectTo: new URL('/reset-password', authContext.baseURL).toString() },
    })
  }
  return { ok: true }
})
