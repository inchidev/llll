import { sendChannelMessage } from './message-service'
import { createAgentRun } from './agent-run-service'
import { nextScheduleAt } from '../../shared/schedules'
import type { L4Env } from '../../workers/env'
import { asRpc } from '../../workers/env'
import { hasPermission, Permission } from '../../shared/permissions'
import { resourceAccessWithin } from '../../shared/resource-access'
import type { AuthorizationContext } from '../../shared/authorization'
import { findCodeEnvironment } from './code-environment-service'
import { authorizeResource } from '../../shared/authorization'
import { intersectResources, type RunMandate } from '../../shared/agent-execution'
import { scheduleRequestSchema, type Schedule, type ScheduleRequest } from '../../shared/schedules'
import { newId, nowIso } from '../../shared/ids'
import { loadAuthorizationContext } from './authorization'
import { requireChannelAccessForMember, requireMemberForUser } from './channel-access'
import { getTask } from './task-service'
import { fail } from './cf'

const columns = `id,principal_id as principalId,created_by as createdBy,channel_id as channelId,kind,content,
 agent_id as agentId,task_id as taskId,first_at as firstAt,timezone,recurrence,next_at as nextAt,status,
 last_error as lastError,authorization_json as authorizationJson,mandate_json as mandateJson,created_at as createdAt`
export async function findSchedule(env: L4Env, id: string): Promise<Schedule | null> {
  return env.DB.prepare(`SELECT ${columns} FROM agent_schedules WHERE id=?`).bind(id).first<Schedule>()
}
function requireGrant(auth: AuthorizationContext, permission: number) {
  if ((!auth.principal.isOwner && !hasPermission(auth.principal.permissions, permission))
    || (auth.delegation && !auth.delegation.isOwner && !hasPermission(auth.delegation.permissions ?? 0, permission))) fail(403, 'schedule_denied', 'Schedule permission is not granted')
}
export async function scheduleMember(env: L4Env, auth: AuthorizationContext, channelId: string) {
  const ids = [auth.principal.id, ...(auth.delegation ? [auth.delegation.by] : [])]
  let member
  for (const id of ids) {
    const user = await env.DB.prepare("SELECT id,kind,display_name as displayName,avatar_r2_key as avatarR2Key FROM users WHERE id=? AND status='active'")
      .bind(id).first<{ id: string; kind: 'human' | 'agent'; displayName: string; avatarR2Key: string | null }>()
    if (!user) fail(403, 'schedule_revoked', 'Schedule member is unavailable')
    const access = await requireChannelAccessForMember(env, requireMemberForUser(env, user, auth.serverId), channelId, Permission.sendMessages)
    if (id === auth.principal.id) member = { ...access, authorization: auth }
  }
  return member!
}

/** Future deliveries use the saved ceiling and freshly loaded role/resource grants. */
export async function scheduleAuthorization(env: L4Env, item: Schedule) {
  const saved = JSON.parse(item.authorizationJson) as AuthorizationContext
  const current = await loadAuthorizationContext(env, { principalId: item.principalId,
    credential: { kind: saved.principal.kind === 'agent' ? 'agent_runtime' : 'session', id: item.id }, delegatedBy: saved.delegation?.by })
  if (!current || (current.principal.permissions & saved.principal.permissions) !== saved.principal.permissions
    || !resourceAccessWithin(saved.principal.resourceAccess ?? {}, current.principal.resourceAccess)
    || (saved.delegation && (!current.delegation || (!current.delegation.isOwner
      && ((current.delegation.permissions ?? 0) & (saved.delegation.permissions ?? 0)) !== (saved.delegation.permissions ?? 0))
      || !resourceAccessWithin(saved.delegation.resourceAccess ?? {}, current.delegation.resourceAccess)))) fail(403, 'schedule_revoked', 'Schedule authorization was revoked')
  current.principal.permissions = saved.principal.permissions
  current.principal.resourceAccess = saved.principal.resourceAccess
  current.principal.isOwner = false
  if (current.delegation && saved.delegation) current.delegation = { ...saved.delegation, isOwner: false }
  if (current.principal.kind === 'agent') {
    const profile = await env.DB.prepare('SELECT status FROM agents WHERE user_id=?').bind(item.principalId).first<{ status: string }>()
    if (profile?.status !== 'active') fail(403, 'schedule_revoked', 'Agent is unavailable')
  }
  requireGrant(current, Permission.manageSchedules)
  await scheduleMember(env, current, item.channelId)
  return current
}

export async function createSchedule(env: L4Env, auth: AuthorizationContext, request: ScheduleRequest) {
  requireGrant(auth, Permission.manageSchedules)
  if (!env.AGENT_SCHEDULE_DO) fail(409, 'schedule_unavailable', 'Schedule execution is not configured')
  const input = scheduleRequestSchema.parse(request)
  if (Date.parse(input.firstAt) < Date.now() + 5000 || Date.parse(input.firstAt) > Date.now() + 366 * 86400000) fail(400, 'schedule_time', 'Choose a time between five seconds and one year from now')
  await scheduleMember(env, auth, input.channelId)
  let mandate: RunMandate | null = null
  if (input.kind === 'work') {
    requireGrant(auth, Permission.executeTasks)
    requireGrant(auth, Permission.useAgents)
    if (auth.principal.kind === 'agent' && input.agentId !== auth.principal.id) fail(403, 'schedule_denied', 'An agent may schedule only its own work')
    const agent = await loadAuthorizationContext(env, { principalId: input.agentId!, credential: { kind: 'agent_runtime' },
      delegatedBy: auth.delegation?.by ?? auth.principal.id })
    if (!agent || !hasPermission(agent.principal.permissions, Permission.executeTasks)) fail(403, 'schedule_denied', 'Agent task execution is not granted')
    const task = await getTask(env, agent, input.taskId!)
    if (!task || task.assigneeId !== input.agentId) fail(403, 'schedule_denied', 'Task must be assigned to the selected agent')
    const humanPermissions = auth.delegation ? (auth.delegation.isOwner ? auth.principal.permissions : auth.delegation.permissions!) : auth.principal.permissions
    mandate = { permissions: humanPermissions, resourceAccess: auth.delegation?.resourceAccess ?? auth.principal.resourceAccess,
      agentPermissions: agent.principal.permissions & (auth.principal.kind === 'agent' ? auth.principal.permissions : agent.principal.permissions),
      agentResourceAccess: auth.principal.kind === 'agent' ? intersectResources(agent.principal.resourceAccess, auth.principal.resourceAccess) : agent.principal.resourceAccess,
      computer: hasPermission(agent.principal.permissions, Permission.useComputer) && hasPermission(humanPermissions, Permission.useComputer),
      maxSteps: 20, maxModelCalls: 20, maxToolCalls: 100, maxTokens: 64000 }
    if (task.environmentId) {
      if (!mandate.computer) fail(403, 'code_denied', 'Scheduled repository work requires computer permission')
      const environment = await findCodeEnvironment(env, task.environmentId)
      if (!environment?.enabled) fail(403, 'code_denied', 'Repository environment is unavailable')
      authorizeResource(auth, 'repositories', String(environment.sourceRepoId))
      authorizeResource(agent, 'repositories', String(environment.sourceRepoId))
      mandate.environmentId = environment.id
      mandate.environmentVersion = environment.version
    }
  }
  const id = newId()
  await env.DB.prepare(`INSERT INTO agent_schedules(id,principal_id,created_by,channel_id,kind,content,agent_id,task_id,first_at,timezone,recurrence,next_at,status,authorization_json,mandate_json,created_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?,? WHERE (SELECT count(*) FROM agent_schedules WHERE created_by=? AND status='active')<50 RETURNING id`)
    .bind(id, auth.principal.id, auth.delegation?.by ?? auth.principal.id, input.channelId, input.kind, input.content, input.agentId ?? null, input.taskId ?? null,
      new Date(input.firstAt).toISOString(), input.timezone, input.recurrence, new Date(input.firstAt).toISOString(), JSON.stringify(auth), mandate ? JSON.stringify(mandate) : null,
      nowIso(), auth.delegation?.by ?? auth.principal.id).first().then(row => { if (!row) fail(429, 'schedule_limit', 'Active schedule limit reached') })
  await asRpc<{ wake: (id: string) => Promise<void> }>(env.AGENT_SCHEDULE_DO.getByName(`schedule:${id}`)).wake(id)
  return publicSchedule((await findSchedule(env, id))!)
}
export function publicSchedule(item: Schedule) {
  const { authorizationJson: _authorization, mandateJson: _mandate, ...publicItem } = item
  return publicItem
}
export async function listSchedules(env: L4Env, auth: AuthorizationContext) {
  requireGrant(auth, Permission.manageSchedules)
  const rows = await env.DB.prepare(`SELECT ${columns} FROM agent_schedules WHERE created_by=? OR principal_id=? ORDER BY created_at DESC LIMIT 100`)
    .bind(auth.delegation?.by ?? auth.principal.id, auth.principal.id).all<Schedule>()
  const visible = []
  for (const row of rows.results ?? []) {
    try { await scheduleMember(env, auth, row.channelId); visible.push(publicSchedule(row)) } catch { /* Private or removed conversation. */ }
  }
  return visible
}
export async function cancelSchedule(env: L4Env, auth: AuthorizationContext, id: string) {
  requireGrant(auth, Permission.manageSchedules)
  const item = await findSchedule(env, id)
  if (!item || (item.createdBy !== (auth.delegation?.by ?? auth.principal.id) && item.principalId !== auth.principal.id)) fail(404, 'not_found', 'Schedule not found')
  await scheduleMember(env, auth, item.channelId)
  await env.DB.prepare("UPDATE agent_schedules SET status='cancelled',next_at=NULL WHERE id=?").bind(id).run()
  await asRpc<{ wake: (id: string) => Promise<void> }>(env.AGENT_SCHEDULE_DO!.getByName(`schedule:${id}`)).wake(id)
}

export async function executeScheduledOccurrence(env: L4Env, item: Schedule, schedule: (promise: Promise<unknown>) => void) {
  if (item.status !== 'active' || !item.nextAt || Date.parse(item.nextAt) > Date.now()) return
  const authorization = await scheduleAuthorization(env, item)
  await env.DB.prepare('INSERT INTO agent_schedule_occurrences(schedule_id,due_at,message_id) VALUES (?,?,?) ON CONFLICT DO NOTHING')
    .bind(item.id, item.nextAt, newId()).run()
  const occurrence = await env.DB.prepare('SELECT message_id as messageId,completed_at as completedAt FROM agent_schedule_occurrences WHERE schedule_id=? AND due_at=?')
    .bind(item.id, item.nextAt).first<{ messageId: string; completedAt: string | null }>()
  let runId: string | null = null
  if (!occurrence!.completedAt) {
    if (item.kind === 'reminder') {
      await sendChannelMessage(env, await scheduleMember(env, authorization, item.channelId), item.channelId,
        { content: `Reminder: ${item.content}` }, schedule, occurrence!.messageId, false)
    } else {
      const human = authorization.principal.kind === 'human' ? authorization
        : await loadAuthorizationContext(env, { principalId: item.createdBy, credential: { kind: 'session' } })
      if (!human) throw Object.assign(new Error('Schedule creator unavailable'), { statusCode: 403 })
      runId = (await createAgentRun(env, human, { agentId: item.agentId!, taskId: item.taskId!, channelId: item.channelId,
        prompt: item.content, idempotencyKey: `schedule:${item.id}:${item.nextAt}` }, JSON.parse(item.mandateJson!) as RunMandate)).id
    }
  }
  const nextAt = nextScheduleAt(item, item.nextAt, nowIso())
  await env.DB.batch([
    env.DB.prepare('UPDATE agent_schedule_occurrences SET completed_at=COALESCE(completed_at,?),run_id=COALESCE(run_id,?) WHERE schedule_id=? AND due_at=?')
      .bind(nowIso(), runId, item.id, item.nextAt),
    env.DB.prepare("UPDATE agent_schedules SET next_at=?,status=?,last_error=NULL WHERE id=? AND status='active' AND next_at=?")
      .bind(nextAt, nextAt ? 'active' : 'completed', item.id, item.nextAt),
  ])
}
