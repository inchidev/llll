import { runPublication, runPublicationHistory } from '../../utils/run-publication'
import { runToolSecurity, requireRunReader } from '../../utils/agent-tool-security'
import { runDelivery } from '../../utils/agent-run-delivery'
import { requireRunFiles } from '../../utils/agent-files'
import { Permission, hasPermission } from '../../../shared/permissions'
import { getTask } from '../../utils/task-service'
import { findAgentRun } from '../../utils/agent-run-service'
import { requireChannelAccess } from '../../utils/guards'
import { cf, fail } from '../../utils/cf'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  const { env } = cf(event)
  const run = await findAgentRun(env, getRouterParam(event, 'id')!)
  if (!run) fail(404, 'not_found', 'Run not found')
  const actor = await requireChannelAccess(event, run.channelId)
  requireRunReader(run, actor.user.id)
  const task = run.taskId ? await getTask(env, actor.authorization, run.taskId) : null
  const agent = await env.DB.prepare('SELECT display_name AS displayName FROM users WHERE id=?').bind(run.agentId).first<{ displayName: string }>()
  if (run.environmentJson) await requireRunFiles(env, actor.authorization, run)
  const { instructions: _instructions, mandateJson: _mandate, environmentJson: _environment, filesKey: _files, ...visible } = run
  const events = await env.DB.prepare('SELECT sequence,event_json as event,created_at as createdAt FROM agent_run_events WHERE run_id=? ORDER BY sequence LIMIT 200').bind(run.id).all<{ sequence: number; event: string; createdAt: string }>()
  const modelCalls = await env.DB.prepare('SELECT call_number AS callNumber,model,status,started_at AS startedAt,completed_at AS completedAt,total_tokens AS totalTokens,error FROM agent_model_calls WHERE run_id=? ORDER BY call_number LIMIT 100').bind(run.id).all()
  const factoryCalls = await env.DB.prepare("SELECT call_id AS callId,status,substr(arguments_json,1,16000) AS argumentsJson,CASE WHEN status='failed' THEN substr(result_json,1,1000) ELSE NULL END AS error,created_at AS createdAt FROM agent_run_tools WHERE run_id=? AND name='factory_workspace' ORDER BY created_at DESC LIMIT 30").bind(run.id).all()
  return { agentName: agent?.displayName ?? null, task: task ? { id: task.id, number: task.number, title: task.title } : null, factoryCalls: factoryCalls.results, publicationHistory: await runPublicationHistory(env, run.id, actor.user.id), publication: await runPublication(env, run.id, actor.user.id), security: await runToolSecurity(env, run), delivery: await runDelivery(env, run.id), canRetry: actor.user.id === run.initiatedBy, modelCalls: modelCalls.results, events: events.results.map(row => ({ ...row, event: JSON.parse(row.event) })), run: { ...visible, hasFactory: Boolean(run.environmentJson && JSON.parse(run.environmentJson).computeNodeId), hasFiles: Boolean(run.filesKey) }, canCancel: actor.user.id === run.initiatedBy || actor.isOwner || hasPermission(actor.perms, Permission.manageAgents) }
})
