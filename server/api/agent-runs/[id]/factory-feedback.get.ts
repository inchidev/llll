import { cf, fail } from '../../../utils/cf'
import { requireChannelAccess } from '../../../utils/guards'
import { findAgentRun } from '../../../utils/agent-run-service'
import { factoryFeedback } from '../../../utils/factory-github'
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  const { env } = cf(event), run = await findAgentRun(env, getRouterParam(event, 'id')!)
  if (!run) fail(404, 'not_found', 'Run not found')
  const actor = await requireChannelAccess(event, run.channelId)
  return factoryFeedback(env, run.id, undefined, actor.user.id)
})
