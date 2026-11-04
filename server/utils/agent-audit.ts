import type { L4Env } from '../../workers/env'
import type { AuthorizationContext } from '../../shared/authorization'
import { spaceSql } from '../../shared/spaces'
import type { AgentAuditChange, AgentAuditPage, AgentAuditRun } from '../../shared/agent-audit'

export async function agentAuditPage(env: L4Env, view: 'runs' | 'changes', search: string, page: number, auth: Pick<AuthorizationContext, 'spaces'> = {}): Promise<AgentAuditPage> {
  const spaces = spaceSql(auth)
  if (view === 'runs') {
    const from = `FROM agent_runs r JOIN users a ON a.id=r.agent_id JOIN users i ON i.id=r.initiated_by WHERE r.channel_id IN (SELECT id FROM channels WHERE space_id IN (${spaces})) AND instr(lower(a.display_name||' '||i.display_name||' '||r.status||' '||r.model),?)>0`
    const total = await env.DB.prepare(`SELECT count(*) as total ${from}`).bind(search.toLowerCase()).first<{ total: number }>()
    const rows = await env.DB.prepare(`SELECT 'run' as kind,r.id,r.created_at as createdAt,a.display_name as agentName,r.initiated_by as initiatedBy,i.display_name as initiatorName,r.status,CASE WHEN r.last_error IS NOT NULL THEN 'Private Run details' END as lastError,r.model,r.model_calls as modelCalls,r.total_tokens as totalTokens,(SELECT count(*) FROM agent_run_tools t WHERE t.run_id=r.id) as toolCalls ${from} ORDER BY r.id DESC LIMIT 20 OFFSET ?`).bind(search.toLowerCase(), (page - 1) * 20).all<AgentAuditRun>()
    return { entries: rows.results, total: total?.total ?? 0 }
  }
  // An Agent has one Space, so a row in any other marks it as outside. Removed Agents have none and stay listed.
  const outside = (id: string) => `EXISTS (SELECT 1 FROM space_members s WHERE s.user_id=${id} AND s.space_id NOT IN (${spaces}))`
  const from = `FROM audit_log l JOIN users u ON u.id=l.actor_id WHERE l.action NOT GLOB 'tool.connection.*' AND (l.action GLOB 'agent.*' OR l.action GLOB 'ai.function.*' OR u.kind='agent')
    AND NOT (u.kind='agent' AND ${outside('u.id')}) AND NOT (l.target_type='agent' AND ${outside('l.target_id')})
    AND NOT EXISTS (SELECT 1 FROM agent_runs r JOIN channels c ON c.id=r.channel_id WHERE r.id=json_extract(l.meta_json,'$.runId') AND c.space_id NOT IN (${spaces}))
    AND instr(lower(u.display_name||' '||l.action||' '||l.target_type||' '||l.target_id),?)>0`
  const total = await env.DB.prepare(`SELECT count(*) as total ${from}`).bind(search.toLowerCase()).first<{ total: number }>()
  const details = ['model', 'status', 'error', 'totalTokens'].map(key => `CASE WHEN l.action GLOB 'ai.function.*' THEN json_extract(l.meta_json,'$.${key}') END as ${key}`).join(',')
  const rows = await env.DB.prepare(`SELECT 'change' as kind,l.id,l.created_at as createdAt,u.display_name as actorName,l.action,l.target_type as targetType,l.target_id as targetId,${details} ${from} ORDER BY l.id DESC LIMIT 20 OFFSET ?`).bind(search.toLowerCase(), (page - 1) * 20).all<AgentAuditChange>()
  return { entries: rows.results, total: total?.total ?? 0 }
}
