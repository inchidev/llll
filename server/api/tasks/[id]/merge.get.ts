import { taskMergeState } from '../../../utils/factory-merge'
import { cf } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { getServerId } from '../../../../shared/server-id'
/** The Task's code as the Task shows it: its Git flow, pull request or pushed commit, and whether it can be merged now. */
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  const { env } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB))
  return taskMergeState(env, actor.authorization, getRouterParam(event, 'id')!)
})
