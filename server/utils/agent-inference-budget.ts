import type { AgentRun, RunMandate } from '../../shared/agent-execution'
import type { L4Env } from '../../workers/env'

const DAILY_TOKENS = 250000

/** Reserve atomically; a policy denial cannot improve by retrying the same Run. */
export async function reserveRunInference(env: Pick<L4Env, 'DB'>, run: AgentRun, reservation: number) {
  const mandate = JSON.parse(run.mandateJson) as RunMandate
  const dailyTokens = mandate.execution?.dailyTokens ?? DAILY_TOKENS
  const since = new Date(Date.now() - 86400000).toISOString()
  const rootId = mandate.rootRunId ?? run.id
  const admitted = await env.DB.prepare(`UPDATE agent_runs SET model_calls=model_calls+1,total_tokens=total_tokens+? WHERE id=? AND status='running'
    AND model_calls<? AND total_tokens+?<=?
    AND (SELECT COALESCE(SUM(model_calls),0) FROM agent_runs WHERE COALESCE(json_extract(mandate_json,'$.rootRunId'),id)=?)<?
    AND (SELECT COALESCE(SUM(total_tokens),0) FROM agent_runs WHERE COALESCE(json_extract(mandate_json,'$.rootRunId'),id)=?)+?<=?
    AND (SELECT COALESCE(SUM(total_tokens),0) FROM agent_runs WHERE agent_id=? AND created_at>=?)+?<=? RETURNING model_calls AS callNumber`)
    .bind(reservation, run.id, mandate.maxModelCalls, reservation, mandate.maxTokens, rootId, mandate.maxModelCalls, rootId, reservation, mandate.maxTokens, run.agentId, since, reservation, dailyTokens).first<{ callNumber: number }>()
  if (admitted) return { ok: true as const, callNumber: admitted.callNumber }
  const current = await env.DB.prepare(`SELECT status,model_calls AS modelCalls,total_tokens AS totalTokens,
    (SELECT COALESCE(SUM(total_tokens),0) FROM agent_runs WHERE agent_id=? AND created_at>=?) AS dailyTokens
    FROM agent_runs WHERE id=?`).bind(run.agentId, since, run.id).first<{ status: string; modelCalls: number; totalTokens: number; dailyTokens: number }>()
  const [code, message]: [string, string] = !current || current.status !== 'running'
    ? ['run_inactive', 'This Run is no longer active. Review its current state before starting another attempt.']
    : current.modelCalls >= mandate.maxModelCalls
      ? ['run_model_call_limit', 'This Run reached its model-call limit. Review its progress before starting another attempt.']
      : current.totalTokens + reservation > mandate.maxTokens
        ? ['run_token_budget', 'This Run cannot fit another request within its token budget, including the reserved response allowance. Review its progress and limits before starting another attempt.']
        : current.dailyTokens + reservation > dailyTokens
          ? ['agent_daily_token_budget', 'This agent cannot fit another request within its rolling 24-hour token budget, including the reserved response allowance. Wait for earlier usage to leave the window, or ask the operator to review its usage.']
          : ['run_admission_changed', 'Run inference admission changed. Review the current Run before retrying.']
  await env.DB.prepare("UPDATE agent_runs SET last_error=? WHERE id=? AND status='running'").bind(message, run.id).run()
  return { ok: false as const, status: code === 'run_inactive' || code === 'run_admission_changed' ? 409 : 400, code, message }
}
