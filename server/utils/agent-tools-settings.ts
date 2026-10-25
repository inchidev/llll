import { getServerId } from '../../shared/server-id'
import { hasPermission, Permission } from '../../shared/permissions'
import type { AuthorizationContext } from '../../shared/authorization'
import type { ToolsSettingsDTO, ToolAuditPage, ToolAuditEntry } from '../../shared/agent-tools-settings'
import { resourceAccessAllows } from '../../shared/resource-access'
import { agentBrowserConfigured, type L4Env } from '../../workers/env'
import { agentTools } from './agent-tools'
import { loadAuthorizationContext } from './authorization'
import { mcpToolExposure } from './outbound-mcp'
import { fail } from './cf'
function human(actor: AuthorizationContext) {
  if (actor.principal.kind !== 'human' || actor.credential.kind !== 'session' || actor.delegation) fail(403, 'tools_denied', 'Sign in to inspect Agent tools')
}
const granted = (actor: AuthorizationContext, permission: number) => actor.principal.isOwner || hasPermission(actor.principal.permissions, permission)
export async function toolsSettings(env: L4Env, actor: AuthorizationContext, agentId?: string): Promise<ToolsSettingsDTO> {
  human(actor)
  if (actor.serverId !== await getServerId(env.DB)) fail(404, 'not_found', 'Server not found')
  if (![Permission.useAgents, Permission.manageAgents, Permission.useExternalTools].some(flag => granted(actor, flag))) fail(403, 'tools_denied', 'Your Role cannot inspect Agent tools')
  const agents = await env.DB.prepare("SELECT u.id,u.display_name AS name,u.role_id AS roleId,a.status FROM users u JOIN agents a ON a.user_id=u.id WHERE u.status='active' AND u.kind='agent' ORDER BY u.display_name LIMIT 200").all<ToolsSettingsDTO['agents'][number]>()
  const members = actor.principal.isOwner ? (await env.DB.prepare("SELECT id,display_name AS name FROM users WHERE kind='human' AND status='active' ORDER BY display_name LIMIT 200").all<{id: string; name: string}>()).results : []
  const roles = actor.principal.isOwner ? (await env.DB.prepare('SELECT id,name FROM roles ORDER BY position LIMIT 200').all<{id: string; name: string}>()).results : []
  const result: ToolsSettingsDTO = { agents: agents.results, members, roles, mayConnect: granted(actor, Permission.useExternalTools), mayManageServer: actor.principal.isOwner, mayPreview: granted(actor, Permission.useAgents), mayAudit: granted(actor, Permission.useExternalTools),
    capabilities: [
      { name: 'Built-in Server tools', available: true, detail: 'Tasks, Data, documents and time. Current Agent and initiating Member Roles/resources govern every call.' },
      { name: 'Read-only MCP', available: granted(actor, Permission.useExternalTools), detail: 'Reviewed public providers only. Both parties need Use external tools and an explicit connection grant. New Runs snapshot connection revisions.' },
      { name: 'Public page reading', available: agentBrowserConfigured(env), detail: 'Requires configured Browser access and Browse web for both parties. Search additionally needs a configured search source; Run admission checks its current availability.' },
      { name: 'Computer execution', available: Boolean(env.AGENT_COMPUTE || (env.AGENT_RUNNER_URL && env.AGENT_RUNNER_TOKEN)), detail: 'Requires a Task and Use computer for both parties. Repository access and Run limits apply.' },
      { name: 'Repository proposals', available: Boolean(env.GITHUB_AGENT_APP_ID && env.GITHUB_AGENT_APP_PRIVATE_KEY), detail: 'Requires a configured repository environment, dedicated GitHub App, Use computer and Propose code changes. Draft PRs only.' },
      { name: 'External writes and approvals', available: false, detail: 'Unavailable until the approval policy is implemented. No approval or external write authority is granted here.' },
    ] }
  if (agentId) {
    if (!result.mayPreview) fail(403, 'tools_denied', 'Use agents is required to preview a Run initiated by you')
    const agent = agents.results.find(agent => agent.id === agentId)
    if (!agent) fail(404, 'not_found', 'Agent not found')
    const auth = await loadAuthorizationContext(env, { principalId: agentId, credential: { kind: 'agent_runtime' }, delegatedBy: actor.principal.id })
    if (!auth) fail(404, 'not_found', 'Agent not found')
    const builtins = await agentTools(env, auth, () => {}).catalog()
    const external = await mcpToolExposure(env, auth)
    result.preview = { agentId, tools: [...builtins, ...external], diagnostics: [
      'Preview uses current Agent and your Role/resource grants. A Task, conversation, Run mandate and current connection revision can narrow access further.',
      'Only shared, enabled, unexpired MCP connections are shown. Missing grants or unavailable connections do not disclose their identities.',
      'Task execution, schedules and repository/computer tools additionally require a suitable active Run.',
      ...[{flag:Permission.readTasks,label:'Read tasks'},{flag:Permission.writeTasks,label:'Write tasks'},{flag:Permission.readData,label:'Read Data'},{flag:Permission.browseWeb,label:'Browse web'},{flag:Permission.useComputer,label:'Use computer'}].flatMap(({flag,label}) => {
        const missing = [!hasPermission(auth.principal.permissions,flag) ? 'Agent Role' : '', !granted(actor,flag) ? 'your Role' : ''].filter(Boolean)
        return missing.length ? [`${label} is unavailable: ${missing.join(' and ')} needs the grant.`] : []
      }),
      ...(agent.status !== 'active' ? ['This Agent is paused; enable it before starting work.'] : []),
      ...(!hasPermission(auth.principal.permissions, Permission.useExternalTools) || !granted(actor, Permission.useExternalTools) ? ['Use external tools must be granted to both the Agent and initiating Member.'] : []),
    ] }
  }
  return result
}
export async function toolAudit(env: L4Env, actor: AuthorizationContext, search: string, page: number): Promise<ToolAuditPage> {
  human(actor)
  if (!granted(actor, Permission.useExternalTools)) fail(403, 'tools_audit_denied', 'Use external tools is required to inspect your connection audit')
  if (actor.serverId !== await getServerId(env.DB)) fail(404, 'not_found', 'Server not found')
  // Explicit safe fields only: never read arbitrary metadata/arguments/results or credential columns.
  const ownership = actor.principal.isOwner ? "(c.owner_id IS NULL OR c.owner_id=?)" : "c.owner_id=?"
  const removed = actor.principal.isOwner ? "(json_type(l.meta_json,'$.ownerId')='null' OR json_extract(l.meta_json,'$.ownerId')=?)" : "json_extract(l.meta_json,'$.ownerId')=?"
  const from = "FROM audit_log l JOIN users u ON u.id=l.actor_id LEFT JOIN agent_runs r ON r.id=json_extract(l.meta_json,'$.runId') LEFT JOIN tasks t ON t.id=r.task_id LEFT JOIN mcp_outbound_connections c ON c.id=l.target_id WHERE l.action GLOB 'tool.connection.*' AND ((c.id IS NOT NULL AND "+ownership+") OR (c.id IS NULL AND "+removed+")) AND instr(lower(u.display_name||' '||l.action||' '||coalesce(c.name,'')||' '||l.target_id||' '||coalesce(json_extract(l.meta_json,'$.tool'),'')||' '||coalesce(json_extract(l.meta_json,'$.status'),'')),?)>0"
  const total = await env.DB.prepare(`SELECT count(*) AS total ${from}`).bind(actor.principal.id,actor.principal.id,search.toLowerCase()).first<{total:number}>()
  const rows = await env.DB.prepare(`SELECT l.id,l.created_at AS createdAt,l.action,u.display_name AS actorName,l.target_id AS connectionId,c.name AS connectionName,r.id AS runId,r.task_id AS taskId,t.discussion_channel_id AS discussionId,json_extract(l.meta_json,'$.tool') AS tool,json_extract(l.meta_json,'$.status') AS status,json_extract(l.meta_json,'$.schemaHash') AS schemaHash ${from} ORDER BY l.id DESC LIMIT 20 OFFSET ?`).bind(actor.principal.id,actor.principal.id,search.toLowerCase(),(page-1)*20).all<ToolAuditEntry>()
  // Links retain normal destination authorization; omit Task links outside current board access.
  const entries = await Promise.all(rows.results.map(async row => {
    if (row.taskId) { const task = await env.DB.prepare('SELECT board_id AS boardId FROM tasks WHERE id=?').bind(row.taskId).first<{boardId:string}>(); if (!task || !resourceAccessAllows(actor.principal.resourceAccess,'boards',task.boardId)) return {...row, taskId:null, discussionId:null} }
    return row
  }))
  return { entries, total: total?.total ?? 0 }
}
