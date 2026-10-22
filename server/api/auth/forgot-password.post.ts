import { z } from 'zod'
import { loadAuthRuntimeConfig, publicAuthConfig } from '../../utils/auth-config'
import { authFromEvent, authRequestContext } from '../../utils/better-auth'
import { asRpc, cf, fail } from '../../utils/cf'
import { ensureMigrated } from '../../utils/db'
import { parseBody } from '../../utils/validate'

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

  const ip = getHeader(event, 'cf-connecting-ip') || getHeader(event, 'x-forwarded-for') || 'local'
  let allowed = true
  try {
    const limiter = asRpc<{ take: (limit: number, windowMs: number) => Promise<boolean> }>(env.RATE_LIMIT_DO.getByName(`ip:${ip}:password-reset`))
    allowed = await limiter.take(5, 60 * 60 * 1000)
  }
  catch {
    // nuxt cloudflare-dev does not export DOs
  }
  if (!allowed) fail(429, 'rate_limited', 'Too many password reset attempts')

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
