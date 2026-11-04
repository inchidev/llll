import type { AgentRun } from '../../shared/agent-execution'
import type { L4Env } from '../../workers/env'
import { nowIso } from '../../shared/ids'

/** Model prose cannot settle an outstanding effect or claim coding work without receipts. */
export async function factoryCompletion(env: L4Env, run: AgentRun) {
  if (!run.taskId || !run.environmentJson || !JSON.parse(run.environmentJson).computeNodeId || !JSON.parse(run.mandateJson).computer) return { pending: false, missingWork: false }
  const pending = await env.DB.prepare("SELECT 1 FROM factory_actions WHERE run_id=? AND status IN ('pending','approved','claimed','executing') AND expires_at>? LIMIT 1").bind(run.id, nowIso()).first()
  const work = await env.DB.prepare(`SELECT 1 FROM factory_actions a JOIN factory_workspaces w ON w.id=a.workspace_id
    WHERE w.task_id=? AND w.agent_id=? AND w.initiated_by=? AND w.channel_id=? AND w.environment_json=?
    AND a.status='completed' AND json_extract(a.request_json,'$.operation') IN ('exec','write','snapshot','publish') LIMIT 1`)
    .bind(run.taskId, run.agentId, run.initiatedBy, run.channelId, run.environmentJson).first()
  return { pending: Boolean(pending), missingWork: !work }
}
