import { findAgentRun } from '../../../utils/agent-run-service'
import { requireChannelAccess } from '../../../utils/guards'
import { cf, fail, asRpc } from '../../../utils/cf'
import { deleteAgentTurn, fanoutAgentTurns } from '../../../../workers/agent-turns'
export default defineEventHandler(async event => {
  const { env } = cf(event)
  const queued = await findAgentRun(env, getRouterParam(event, 'id')!)
  if (!queued || !env.AGENT_RUN_DO) fail(404, 'not_found', 'Queued message not found')
  const actor = await requireChannelAccess(event, queued.channelId)
  if (actor.user.id !== queued.initiatedBy) fail(403, 'forbidden', 'Only the sender can steer this message')
  const active = await env.DB.prepare(`SELECT id FROM agent_runs WHERE agent_id=? AND initiated_by=? AND (SELECT COALESCE(parent_id,id) FROM channels WHERE id=agent_runs.channel_id)=(SELECT COALESCE(parent_id,id) FROM channels WHERE id=?) AND status='running' ORDER BY created_at DESC LIMIT 1`).bind(queued.agentId, queued.initiatedBy, queued.channelId).first<{ id: string }>()
  if (!active || !queued.sourceMessageId) fail(409, 'not_running', 'The agent is no longer working on this conversation')
  // Claim before steering: the queued Run cannot start at the same time.
  const claimed = await env.DB.prepare("UPDATE agent_runs SET status='cancelled',last_error='Steering queued message',updated_at=? WHERE id=? AND status='queued' RETURNING id").bind(new Date().toISOString(), queued.id).first()
  if (!claimed) fail(409, 'already_started', 'This message is already being processed')
  await env.DB.prepare('UPDATE agent_sessions SET active_run_id=NULL WHERE id=? AND active_run_id=?').bind(queued.sessionId, queued.id).run()
  let accepted = false
  try { accepted = await asRpc<{ steer: (messageId: string, content: string, actorId: string) => Promise<boolean> }>(env.AGENT_RUN_DO.getByName(`run:${active.id}`)).steer(queued.sourceMessageId, queued.prompt, queued.initiatedBy) }
  catch { /* Restore only on an explicit false below; uncertain delivery must not run twice. */
    await deleteAgentTurn(env, queued.id)
    await fanoutAgentTurns(env, queued.channelId, queued.agentId)
    fail(503, 'steer_uncertain', 'Steering delivery is uncertain. Check the current run before sending again.')
  }
  if (!accepted) {
    await env.DB.prepare("UPDATE agent_runs SET status='queued',last_error=NULL WHERE id=? AND status='cancelled'").bind(queued.id).run()
    await asRpc<{ wake: (id: string) => Promise<void> }>(env.AGENT_RUN_DO.getByName(`run:${queued.id}`)).wake(queued.id)
    fail(409, 'steer_unavailable', 'Steering is unavailable; the message is still queued')
  }
  await deleteAgentTurn(env, queued.id)
  await fanoutAgentTurns(env, queued.channelId, queued.agentId)
  return { status: 'steered' }
})
