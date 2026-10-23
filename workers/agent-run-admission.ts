import type { AgentRun } from '../shared/agent-execution'
import type { L4Env } from './env'
import { nowIso } from '../shared/ids'

/** One running reply per conversation, in send order, even when messages create separate threads. */
export async function admitQueuedAgentRun(env: L4Env, run: Pick<AgentRun, 'id' | 'agentId' | 'channelId' | 'sessionId'>): Promise<boolean> {
  const claim = await env.DB.prepare('UPDATE agent_sessions SET active_run_id=? WHERE id=? AND (active_run_id IS NULL OR active_run_id=?) RETURNING id')
    .bind(run.id, run.sessionId, run.id).first()
  if (!claim) return false
  const now = nowIso()
  const admitted = await env.DB.prepare(`UPDATE agent_runs SET status='running',updated_at=? WHERE id=? AND status='queued'
    AND (SELECT count(*) FROM agent_runs WHERE agent_id=? AND status='running')<2
    AND (SELECT count(*) FROM agent_runs WHERE status='running')<4
    AND NOT EXISTS (SELECT 1 FROM agent_runs other JOIN channels c ON c.id=other.channel_id
      WHERE other.agent_id=? AND (other.status='running' OR (other.status='queued' AND other.id<? AND other.deadline>?))
      AND COALESCE(c.parent_id,c.id)=(SELECT COALESCE(parent_id,id) FROM channels WHERE id=?)) RETURNING id`)
    .bind(now, run.id, run.agentId, run.agentId, run.id, now, run.channelId).first()
  return Boolean(admitted)
}
