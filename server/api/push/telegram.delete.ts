import { getServerId } from '../../../shared/server-id'
import { requireMember } from '../../utils/guards'
import { cf } from '../../utils/cf'

/** Stop Telegram notifications for this Account on every Telegram chat it enabled. */
export default defineEventHandler(async (event) => {
  const member = await requireMember(event, (await getServerId(cf(event).env.DB)))
  await cf(event).env.DB.prepare(`DELETE FROM push_subscriptions WHERE user_id = ? AND transport = 'telegram'`).bind(member.user.id).run()
  return { subscribed: false }
})
