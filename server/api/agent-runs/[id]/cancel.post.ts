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
  if (!['queued', 'running'].includes(run.status)) fail(409, 'run_finished', `Run is already ${run.status}`)
  await asRpc<{ cancel: () => Promise<void> }>(env.AGENT_RUN_DO.getByName(`run:${run.id}`)).cancel()
  const current = await findAgentRun(env, run.id)
  if (current?.status !== 'cancelled') fail(409, 'run_finished', `Run is ${current?.status ?? 'unavailable'}; cancellation did not change its status`)
  return { status: 'cancelled' }
})
