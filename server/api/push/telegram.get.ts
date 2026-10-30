import { getServerId } from '../../../shared/server-id'
import { requireMember } from '../../utils/guards'
import { cf } from '../../utils/cf'

/** Whether this Account receives notifications through Telegram. */
export default defineEventHandler(async (event) => {
  const member = await requireMember(event, (await getServerId(cf(event).env.DB)))
  const row = await cf(event).env.DB.prepare(
    `SELECT 1 AS subscribed FROM push_subscriptions WHERE user_id = ? AND transport = 'telegram' LIMIT 1`,
  ).bind(member.user.id).first()
  return { subscribed: Boolean(row) }
})
