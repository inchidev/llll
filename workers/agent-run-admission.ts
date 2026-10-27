import { RUN_EXECUTION_MS, type AgentRun, type RunMandate } from '../shared/agent-execution'
import type { L4Env } from './env'
import { nowIso } from '../shared/ids'

/** One running reply per conversation, in send order, even when messages create separate threads. */
export async function admitQueuedAgentRun(env: L4Env, run: Pick<AgentRun, 'id' | 'agentId' | 'channelId' | 'sessionId'> & Partial<Pick<AgentRun, 'mandateJson'>>): Promise<boolean> {
  const claim = await env.DB.prepare("UPDATE agent_sessions SET active_run_id=? WHERE id=? AND (active_run_id IS NULL OR active_run_id=? OR active_run_id IN (SELECT id FROM agent_runs WHERE status IN ('completed','failed','cancelled'))) RETURNING id")
    .bind(run.id, run.sessionId, run.id).first()
  if (!claim) return false
  const now = nowIso()
  const duration = run.mandateJson ? (JSON.parse(run.mandateJson) as RunMandate).execution?.maxDurationMs ?? RUN_EXECUTION_MS : RUN_EXECUTION_MS
  const rootDeadline = run.mandateJson ? (JSON.parse(run.mandateJson) as RunMandate).rootDeadline : undefined
  const admitted = await env.DB.prepare(`UPDATE agent_runs SET status='running',updated_at=?,deadline=? WHERE id=? AND status='queued'
    AND (SELECT count(*) FROM agent_runs WHERE agent_id=? AND status='running')<2
    AND (SELECT count(*) FROM agent_runs active WHERE active.status='running' AND NOT EXISTS
      (SELECT 1 FROM agent_run_tools t WHERE t.run_id=active.id AND t.name='delegate_task' AND t.status='pending' AND json_extract(t.result_json,'$.delegationPending')=1))<4
    AND NOT EXISTS (SELECT 1 FROM agent_runs other JOIN channels c ON c.id=other.channel_id
      WHERE other.agent_id=? AND (other.status='running' OR (other.status='queued' AND other.id<?))
      AND COALESCE(c.parent_id,c.id)=(SELECT COALESCE(parent_id,id) FROM channels WHERE id=?)) RETURNING id`)
    .bind(now, new Date(Math.min(Date.now() + duration, rootDeadline ? Date.parse(rootDeadline) : Infinity)).toISOString(), run.id, run.agentId, run.agentId, run.id, run.channelId).first()
  return Boolean(admitted)
}
