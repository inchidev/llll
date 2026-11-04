import { z } from 'zod'
import { requireUser } from '../../utils/auth'
import { authFromEvent } from '../../utils/better-auth'
import { parseBody } from '../../utils/validate'

const bodySchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(8).max(200),
})

export default defineEventHandler(async (event) => {
  await requireUser(event)
  const body = parseBody(bodySchema, await readBody(event))
  const auth = await authFromEvent(event)
  await auth.api.changePassword({
    headers: event.headers,
    body: {
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
      revokeOtherSessions: true,
    },
  })
  return { ok: true }
})
