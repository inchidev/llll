import { authFromEvent } from '../../utils/better-auth'
import { cf } from '../../utils/cf'

export default defineEventHandler(async (event) => {
  const path = event.path.split('?')[0]
  if (path === '/api/auth/sign-up/email'
    || path === '/api/auth/sign-in/email'
    || path === '/api/auth/sign-in/social'
    || path === '/api/auth/request-password-reset') {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }
  const auth = await authFromEvent(event)
  const request = toWebRequest(event)
  // Nitro's internal fetch may add sec-fetch-mode: cors. OAuth must see the
  // browser's original navigation headers so it returns an HTTP redirect.
  const original = cf(event).request
  return auth.handler(original ? new Request(request, { headers: original.headers }) : request)
})
