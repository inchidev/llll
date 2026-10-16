import { z } from 'zod'
import { WORKSPACE_ID } from '../../../shared/ids'
import { requireMember } from '../../utils/guards'
import { cf } from '../../utils/cf'
import { parseBody } from '../../utils/validate'

const bodySchema = z.object({ endpoint: z.string().min(1).max(4096) })

export default defineEventHandler(async (event) => {
  const member = await requireMember(event, WORKSPACE_ID)
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  await env.DB.prepare(
    'DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?',
  ).bind(body.endpoint, member.user.id).run()
  return { subscribed: false }
})
