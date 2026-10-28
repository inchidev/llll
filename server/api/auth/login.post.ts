import { z } from 'zod'
import { ensureDomainUser, sessionUser, visibleAuthEmail } from '../../utils/auth'
import { authFromEvent } from '../../utils/better-auth'
import { cf, fail } from '../../utils/cf'
import { ensureMigrated } from '../../utils/db'
import { parseBody } from '../../utils/validate'

const bodySchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
})

export default defineEventHandler(async (event) => {
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  await ensureMigrated(env.DB, env)
  const ip = getHeader(event, 'cf-connecting-ip') || getHeader(event, 'x-forwarded-for') || 'local'
  let allowed = true
  try {
    const limiter = asRpc<{ take: (limit: number, windowMs: number) => Promise<boolean> }>(env.RATE_LIMIT_DO.getByName(`ip:${ip}:login`))
    allowed = await limiter.take(5, 15 * 60 * 1000)
  }
  catch {
    // nuxt cloudflare-dev does not export DOs
  }
  if (!allowed) fail(429, 'rate_limited', 'Too many login attempts')

  const email = body.email.trim().toLowerCase()
  const auth = await authFromEvent(event)
  const res = await auth.api.signInEmail({
    headers: event.headers,
    body: {
      email,
      password: body.password,
    },
    asResponse: true,
  })
  if (!res.ok) {
    const payload = await res.json().catch(() => null) as { code?: string; message?: string } | null
    if (payload?.code === 'EMAIL_NOT_VERIFIED') {
      fail(403, 'email_not_verified', 'Verify your email before signing in')
    }
    if (res.status === 401 || payload?.code === 'INVALID_EMAIL_OR_PASSWORD') {
      fail(401, 'invalid_credentials', 'Invalid email or password')
    }
    // Origin, CSRF and rate-limit refusals are not credential errors; reporting
    // them as a wrong password sends people to reset a password that works.
    if (res.status === 429) fail(429, 'rate_limited', 'Too many login attempts')
    if (res.status === 403) fail(403, 'sign_in_refused', `This Server refused the sign-in request (${payload?.code || 'forbidden'}). Open the Server at its own address and try again.`)
    fail(502, 'sign_in_failed', 'Sign-in failed. Try again in a moment.')
  }
  for (const cookie of res.headers.getSetCookie?.() ?? []) appendResponseHeader(event, 'set-cookie', cookie)
  const signedIn = await res.json() as { user: { id: string; email: string; name: string; image?: string | null } }
  const row = await ensureDomainUser(event, signedIn.user)

  return { user: await sessionUser(event, row, visibleAuthEmail(signedIn.user.email)) }
})
