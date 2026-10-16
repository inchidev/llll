import { z } from 'zod'
import { authFromEvent } from '../../utils/better-auth'
import { fail } from '../../utils/cf'
import { parseBody } from '../../utils/validate'

const bodySchema = z.object({
  token: z.string().min(1).max(2000),
  newPassword: z.string().min(8).max(200),
})

export default defineEventHandler(async (event) => {
  const body = parseBody(bodySchema, await readBody(event))
  const auth = await authFromEvent(event)
  const response = await auth.api.resetPassword({
    headers: event.headers,
    body: {
      token: body.token,
      newPassword: body.newPassword,
    },
    asResponse: true,
  })
  if (!response.ok) fail(400, 'invalid_reset', 'This password reset link is invalid or expired')
  return { ok: true }
})
