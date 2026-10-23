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
  const events = await env.DB.prepare('SELECT sequence,event_json as event,created_at as createdAt FROM agent_run_events WHERE run_id=? ORDER BY sequence LIMIT 200').bind(run.id).all<{ sequence: number; event: string; createdAt: string }>()
  const modelCalls = await env.DB.prepare('SELECT call_number AS callNumber,model,status,started_at AS startedAt,completed_at AS completedAt,total_tokens AS totalTokens,error FROM agent_model_calls WHERE run_id=? ORDER BY call_number LIMIT 100').bind(run.id).all()
  return { modelCalls: modelCalls.results, events: events.results.map(row => ({ ...row, event: JSON.parse(row.event) })), run: { ...visible, hasFiles: Boolean(run.filesKey) }, canCancel: actor.user.id === run.initiatedBy || actor.isOwner || hasPermission(actor.perms, Permission.manageAgents) }
})
