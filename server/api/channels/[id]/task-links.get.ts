import { getServerId } from '../../../../shared/server-id'
import { requireMember } from '../../../utils/guards'
import { cf } from '../../../utils/cf'
import { taskLinksForChannel } from '../../../utils/task-sources'

/** Tasks created from messages in this conversation that the viewer can read. */
export default defineEventHandler(async (event) => {
  const { env } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB))
  return { links: await taskLinksForChannel(env, actor, getRouterParam(event, 'id')!) }
})
