import { getServerId } from '../../../../shared/server-id'
import { cf } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { ensureTaskDiscussion } from '../../../utils/task-discussion'

/** Returns the task's discussion channel, creating it on first use. */
export default defineEventHandler(async (event) => {
  const actor = await requireMember(event, (await getServerId(cf(event).env.DB)))
  return { channelId: await ensureTaskDiscussion(cf(event).env, actor.authorization, getRouterParam(event, 'id')!) }
})
