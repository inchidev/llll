import { Permission, hasPermission } from '../../../shared/permissions'
import { getTask } from '../../utils/task-service'
import { findAgentRun } from '../../utils/agent-run-service'
import { requireChannelAccess } from '../../utils/guards'
import { cf, fail } from '../../utils/cf'

export default defineEventHandler(async (event) => {
  const { env } = cf(event)
  const run = await findAgentRun(env, getRouterParam(event, 'id')!)
  if (!run) fail(404, 'not_found', 'Run not found')
  const actor = await requireChannelAccess(event, run.channelId)
  if (run.taskId) await getTask(env, actor.authorization, run.taskId)
  const { instructions: _instructions, mandateJson: _mandate, ...visible } = run
  return { run: visible, canCancel: actor.user.id === run.initiatedBy || actor.isOwner || hasPermission(actor.perms, Permission.manageAgents) }
})
