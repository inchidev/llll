import { getServerId } from '../../../../shared/server-id'
import { requireMember } from '../../../utils/guards'
import { cf } from '../../../utils/cf'
import { taskDraftFromMessage } from '../../../utils/task-sources'

/** Prefills the Task form from a message the viewer can read. It saves nothing. */
export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  const { env } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB))
  return { draft: await taskDraftFromMessage(env, actor, getRouterParam(event, 'id')!) }
})
