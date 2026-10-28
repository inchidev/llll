import { z } from 'zod'
import { loadAuthRuntimeConfig, publicAuthConfig } from '../../utils/auth-config'
import { authFromEvent, authRequestContext } from '../../utils/better-auth'
import { cf, fail } from '../../utils/cf'
import { ensureMigrated } from '../../utils/db'
import { parseBody } from '../../utils/validate'
import { clientIp, requireRateLimit } from '../../utils/rate-limit'

const bodySchema = z.object({
  email: z.string().email().max(200),
})

export default defineEventHandler(async (event) => {
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  await ensureMigrated(env.DB, env)
  const authContext = await authRequestContext(event)
  const runtime = await loadAuthRuntimeConfig(env, authContext.baseURL)
  if (!publicAuthConfig(runtime).passwordResetEnabled) {
    fail(503, 'password_reset_unavailable', 'Password reset email is not configured')
  }

  // The account budget stops reset mail from being sent to one address over and over.
  await requireRateLimit(event, [
    { key: `ip:${clientIp(event)}:password-reset`, limit: 5, windowMs: 60 * 60 * 1000 },
    { key: `account:${body.email.trim().toLowerCase()}:password-reset`, limit: 3, windowMs: 60 * 60 * 1000 },
  ], 'Too many password reset attempts')

  const baseURL = authContext.baseURL
  const auth = await authFromEvent(event)
  await auth.api.requestPasswordReset({
    headers: event.headers,
    body: {
      email: body.email.trim().toLowerCase(),
      redirectTo: new URL('/reset-password', baseURL).toString(),
    },
  })
  return { ok: true }
})
