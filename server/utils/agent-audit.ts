import type { L4Env } from '../../workers/env'
import type { AgentAuditChange, AgentAuditPage, AgentAuditRun } from '../../shared/agent-audit'

export async function agentAuditPage(env: L4Env, view: 'runs' | 'changes', search: string, page: number): Promise<AgentAuditPage> {
  if (view === 'runs') {
    const from = `FROM agent_runs r JOIN users a ON a.id=r.agent_id JOIN users i ON i.id=r.initiated_by WHERE instr(lower(a.display_name||' '||i.display_name||' '||r.status||' '||r.model),?)>0`
    const total = await env.DB.prepare(`SELECT count(*) as total ${from}`).bind(search.toLowerCase()).first<{ total: number }>()
    const rows = await env.DB.prepare(`SELECT 'run' as kind,r.id,r.created_at as createdAt,a.display_name as agentName,i.display_name as initiatorName,r.status,r.model,r.model_calls as modelCalls,r.total_tokens as totalTokens,(SELECT count(*) FROM agent_run_tools t WHERE t.run_id=r.id) as toolCalls ${from} ORDER BY r.id DESC LIMIT 20 OFFSET ?`).bind(search.toLowerCase(), (page - 1) * 20).all<AgentAuditRun>()
    return { entries: rows.results, total: total?.total ?? 0 }
  }
  const from = `FROM audit_log l JOIN users u ON u.id=l.actor_id WHERE (l.action GLOB 'agent.*' OR u.kind='agent') AND instr(lower(u.display_name||' '||l.action||' '||l.target_type||' '||l.target_id),?)>0`
  const total = await env.DB.prepare(`SELECT count(*) as total ${from}`).bind(search.toLowerCase()).first<{ total: number }>()
  const rows = await env.DB.prepare(`SELECT 'change' as kind,l.id,l.created_at as createdAt,u.display_name as actorName,l.action,l.target_type as targetType,l.target_id as targetId ${from} ORDER BY l.id DESC LIMIT 20 OFFSET ?`).bind(search.toLowerCase(), (page - 1) * 20).all<AgentAuditChange>()
  return { entries: rows.results, total: total?.total ?? 0 }
}
