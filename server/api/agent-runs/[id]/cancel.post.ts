import { findAgentRun } from '../../../utils/agent-run-service'
import { requireChannelAccess } from '../../../utils/guards'
import { cf, fail, asRpc } from '../../../utils/cf'
import { Permission, hasPermission } from '../../../../shared/permissions'

export default defineEventHandler(async (event) => {
  const { env } = cf(event)
  const run = await findAgentRun(env, getRouterParam(event, 'id')!)
  if (!run || !env.AGENT_RUN_DO) fail(404, 'not_found', 'Run not found')
  const actor = await requireChannelAccess(event, run.channelId)
  if (actor.user.id !== run.initiatedBy && !actor.isOwner && !hasPermission(actor.perms, Permission.manageAgents)) fail(403, 'forbidden', 'Cannot cancel this run')
  await asRpc<{ cancel: () => Promise<void> }>(env.AGENT_RUN_DO.getByName(`run:${run.id}`)).cancel()
  return { status: 'cancelled' }
})
