import { z } from 'zod'
import { isUsername, loginSchema } from '../../../shared/account'
import { ensureDomainUser, sessionUser } from '../../utils/auth'
import { accountEmail, findAccountByVerifiedEmail, isPasswordlessAccount, unknownUsername } from '../../utils/account-identity'
import { authFromEvent } from '../../utils/better-auth'
import { cf, fail } from '../../utils/cf'
import { ensureMigrated, getDb } from '../../utils/db'
import { hashPassword } from '../../utils/password'
import { parseBody } from '../../utils/validate'
import { clientIp, requireRateLimit } from '../../utils/rate-limit'

const bodySchema = z.object({
  login: loginSchema,
  password: z.string().min(1).max(200),
})
const ACCOUNT_LIMIT = { limit: 20, windowMs: 15 * 60 * 1000 }

export default defineEventHandler(async (event) => {
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  await ensureMigrated(env.DB, env)
  // Address and account budgets: rotating addresses cannot keep guessing one account.
  await requireRateLimit(event, [
    { key: `ip:${clientIp(event)}:login`, limit: 5, windowMs: 15 * 60 * 1000 },
    { key: `account:${body.login}:login`, ...ACCOUNT_LIMIT },
  ], 'Too many login attempts')
  const auth = await authFromEvent(event)
  // The plugin has no such switch of its own: it signs in whatever emailAndPassword says.
  if (!(await auth.$context).options.emailAndPassword?.enabled) fail(403, 'method_disabled', 'Login method is not available')

  const db = getDb(env.DB)
  const account = isUsername(body.login) ? null : await findAccountByVerifiedEmail(db, body.login)
  // Username and email share a budget, so holding both gives a guesser no extra tries.
  if (account) await requireRateLimit(event, [{ key: `account:${account.username}:login`, ...ACCOUNT_LIMIT }], 'Too many login attempts')
  // A value naming no Account still goes through Better Auth: it hashes the password and
  // answers exactly as for a wrong password, so neither the reply nor its timing tells them apart.
  const username = isUsername(body.login) ? body.login : account?.username ?? unknownUsername()
  const res = await auth.api.signInUsername({
    headers: event.headers,
    body: { username, password: body.password },
    asResponse: true,
  })
  if (!res.ok) {
    const payload = await res.json().catch(() => null) as { code?: string; message?: string } | null
    if (res.status === 401) {
      // The plugin answers an Account with no password before any hashing, which would show the name is taken.
      if (await isPasswordlessAccount(db, username)) await hashPassword(body.password)
      fail(401, 'invalid_credentials', 'Wrong username, email or password')
    }
    // Origin, CSRF and rate-limit refusals are not credential errors; reporting
    // them as a wrong password sends people to reset a password that works.
    if (res.status === 429) fail(429, 'rate_limited', 'Too many login attempts')
    if (res.status === 403) fail(403, 'sign_in_refused', `This Server refused the sign-in request (${payload?.code || 'forbidden'}). Open the Server at its own address and try again.`)
    fail(502, 'sign_in_failed', 'Sign-in failed. Try again in a moment.')
  }
  for (const cookie of res.headers.getSetCookie?.() ?? []) appendResponseHeader(event, 'set-cookie', cookie)
  const signedIn = await res.json() as { user: { id: string; email: string; username?: string | null; displayUsername?: string | null; name: string; image?: string | null } }
  const row = await ensureDomainUser(event, signedIn.user)

  return { user: await sessionUser(event, row, { username: signedIn.user.username, displayUsername: signedIn.user.displayUsername, email: accountEmail(signedIn.user) }) }
})
