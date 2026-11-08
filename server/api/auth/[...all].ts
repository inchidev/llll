import { authFromEvent } from '../../utils/better-auth'
import { cf } from '../../utils/cf'
import { hidePlaceholderEmails } from '../../utils/account-identity'

/**
 * These go through our own routes, which apply username, verified-email, invite and
 * rate-limit rules. Better Auth's own versions know nothing of them. Server code still
 * reaches them through `auth.api`.
 */
const CLOSED_PATHS = new Set([
  '/api/auth/sign-up/email',
  '/api/auth/sign-in/email',
  '/api/auth/sign-in/social',
  // Without our rate limits and verified-email rule. Use /api/auth/login.
  '/api/auth/sign-in/username',
  // Would let anyone test names with no limit; the sign-up and settings forms get their answer on submit.
  '/api/auth/is-username-available',
  // Changes the username with no audit entry. Use PATCH /api/me. Nothing in L4 calls it for a name or image.
  '/api/auth/update-user',
  '/api/auth/request-password-reset',
  '/api/auth/send-verification-email',
  '/api/auth/verify-email',
  '/api/auth/change-email',
  // Without the rate limit and the Member check. Use /api/auth/link.
  '/api/auth/link/exchange',
])

export default defineEventHandler(async (event) => {
  const request = toWebRequest(event)
  // The URL Better Auth will route, not the raw path: `/a/../sign-in/email` resolves to a closed path.
  if (CLOSED_PATHS.has(new URL(request.url).pathname.replace(/\/+$/u, ''))) throw createError({ statusCode: 404, statusMessage: 'Not found' })
  const auth = await authFromEvent(event)
  // Nitro's internal fetch may add sec-fetch-mode: cors. OAuth must see the
  // browser's original navigation headers so it returns an HTTP redirect.
  const original = cf(event).request
  return hidePlaceholderEmails(await auth.handler(original ? new Request(request, { headers: original.headers }) : request))
})
