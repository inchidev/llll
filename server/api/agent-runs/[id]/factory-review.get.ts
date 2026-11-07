import { z } from 'zod'
import { cf, fail } from '../../../utils/cf'
import { requireChannelAccess } from '../../../utils/guards'
import { findAgentRun } from '../../../utils/agent-run-service'
import { approvalReview } from '../../../utils/factory-approvals'
/** The commits and diff of one push waiting for review, read from R2. */
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  const { env } = cf(event), run = await findAgentRun(env, getRouterParam(event, 'id')!)
  if (!run) fail(404, 'not_found', 'Run not found')
  const actor = await requireChannelAccess(event, run.channelId)
  const approval = z.string().uuid().safeParse(getQuery(event).approval)
  if (!approval.success) fail(400, 'bad_request', 'Choose a request')
  return approvalReview(env, run.id, actor.user.id, approval.data)
})
