import { cf, fail } from '../../../utils/cf'
import { requireChannelAccess } from '../../../utils/guards'
import { findAgentRun } from '../../../utils/agent-run-service'
import { listFactoryActions } from '../../../utils/factory-actions'
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  const { env } = cf(event), run = await findAgentRun(env, getRouterParam(event, 'id')!)
  if (!run) fail(404, 'not_found', 'Run not found')
  const actor = await requireChannelAccess(event, run.channelId)
  return listFactoryActions(env, run.id, actor.user.id)
})
