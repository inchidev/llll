import { z } from 'zod'
import { ensureDomainUser, sessionUser } from '../../utils/auth'
import { accountEmail } from '../../utils/account-identity'
import { authFromEvent } from '../../utils/better-auth'
import { cf, fail } from '../../utils/cf'
import { ensureMigrated } from '../../utils/db'
import { parseBody } from '../../utils/validate'
import { clientIp, requireRateLimit } from '../../utils/rate-limit'

const bodySchema = z.object({ token: z.string().regex(/^[0-9a-f]{64}$/u) })

/** A one-time sign-in link from L4 Cloud (ADR 0012) becomes an ordinary session for the Member it names. */
export default defineEventHandler(async (event) => {
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  await ensureMigrated(env.DB, env)
  await requireRateLimit(event, [{ key: `ip:${clientIp(event)}:signin-link`, limit: 10, windowMs: 15 * 60 * 1000 }], 'Too many sign-in attempts')
  const auth = await authFromEvent(event)
  const response = await auth.api.linkExchange({ headers: event.headers, body: { token: body.token }, asResponse: true })
  if (!response.ok) fail(401, 'invalid_link', 'This sign-in link is invalid, expired or already used')
  for (const cookie of response.headers.getSetCookie?.() ?? []) appendResponseHeader(event, 'set-cookie', cookie)
  const { user } = await response.json() as { user: { id: string; email: string; username?: string | null; displayUsername?: string | null; name: string; image?: string | null } }
  const row = await ensureDomainUser(event, user)
  setResponseHeader(event, 'Cache-Control', 'no-store')
  return { user: await sessionUser(event, row, { username: user.username, displayUsername: user.displayUsername, email: accountEmail(user) }) }
})
