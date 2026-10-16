import { authFromEvent } from '../../utils/better-auth'

export default defineEventHandler(async (event) => {
  const path = event.path.split('?')[0]
  if (path === '/api/auth/sign-up/email'
    || path === '/api/auth/sign-in/email'
    || path === '/api/auth/sign-in/social'
    || path === '/api/auth/request-password-reset') {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }
  const auth = await authFromEvent(event)
  return auth.handler(toWebRequest(event))
})
