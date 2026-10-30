import { getServerId } from '../../../shared/server-id'
import { z } from 'zod'
import { requireMember } from '../../utils/guards'
import { cf } from '../../utils/cf'
import { parseBody } from '../../utils/validate'
import { saveTelegramSubscription } from '../../utils/telegram-subscriptions'

const bodySchema = z.object({
  token: z.string().min(16).max(256).regex(/^[A-Za-z0-9_-]+$/u),
  relayOrigin: z.string().max(2048),
}).strict()

/** Save a Telegram delivery token the Shell, or this Server's own Mini App, got from the relay. */
export default defineEventHandler(async (event) => {
  const member = await requireMember(event, (await getServerId(cf(event).env.DB)))
  const body = parseBody(bodySchema, await readBody(event))
  await saveTelegramSubscription(cf(event).env, member.user.id, body.token, body.relayOrigin, getHeader(event, 'user-agent') ?? null)
  return { subscribed: true }
})
