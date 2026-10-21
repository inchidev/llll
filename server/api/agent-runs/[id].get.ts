import { requireRunFiles } from '../../utils/agent-files'
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
  if (run.environmentJson) await requireRunFiles(env, actor.authorization, run)
  const { instructions: _instructions, mandateJson: _mandate, environmentJson: _environment, filesKey: _files, ...visible } = run
  return { run: { ...visible, hasFiles: Boolean(run.filesKey) }, canCancel: actor.user.id === run.initiatedBy || actor.isOwner || hasPermission(actor.perms, Permission.manageAgents) }
})
