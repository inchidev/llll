import { sendChannelMessage } from './message-service'
import { createAgentRun, piConfigured } from './agent-run-service'
import { nextScheduleAt, SCHEDULE_ACTIVE_LIMIT, scheduleListQuerySchema } from '../../shared/schedules'
import type { L4Env } from '../../workers/env'
import { asRpc } from '../../workers/env'
import { hasPermission, Permission } from '../../shared/permissions'
import { resourceAccessWithin } from '../../shared/resource-access'
import type { AuthorizationContext } from '../../shared/authorization'
import { findCodeEnvironment } from './code-environment-service'
import { authorizeResource } from '../../shared/authorization'
import { intersectResources, type RunMandate } from '../../shared/agent-execution'
import { scheduleRequestSchema, type PublicSchedule, type Schedule, type ScheduleListPage, type ScheduleOccurrence, type ScheduleRequest } from '../../shared/schedules'
import { newId, nowIso } from '../../shared/ids'
import { CHANNEL_ARCHIVED_CODE } from '../../shared/channel-archive'
import { loadAuthorizationContext } from './authorization'
import { requireChannelAccessForMember, requireMemberForUser } from './channel-access'
import { getTask } from './task-service'
import { fail } from './cf'
import type { z } from 'zod'

// A paused mandate keeps status 'active' in storage; every reader sees 'paused' and so never executes it.
const columns = `id,principal_id as principalId,created_by as createdBy,channel_id as channelId,kind,content,
 agent_id as agentId,task_id as taskId,first_at as firstAt,timezone,recurrence,next_at as nextAt,
 CASE WHEN status='active' AND paused_at IS NOT NULL THEN 'paused' ELSE status END as status,
 last_error as lastError,last_error_code as lastErrorCode,authorization_json as authorizationJson,mandate_json as mandateJson,created_at as createdAt`
/** Backoff for transient failures of one occurrence; once exhausted the occurrence is recorded as failed. */
export const SCHEDULE_RETRY_DELAYS = [30_000, 60_000, 300_000, 900_000, 3_600_000]
/** Occurrences kept per schedule for history; older finished ones are pruned as new ones finish. */
const OCCURRENCE_RETENTION = 100

export async function findSchedule(env: L4Env, id: string): Promise<Schedule | null> {
  return env.DB.prepare(`SELECT ${columns} FROM agent_schedules WHERE id=?`).bind(id).first<Schedule>()
}
function requireGrant(auth: AuthorizationContext, permission: number) {
  if ((!auth.principal.isOwner && !hasPermission(auth.principal.permissions, permission))
    || (auth.delegation && !auth.delegation.isOwner && !hasPermission(auth.delegation.permissions ?? 0, permission))) fail(403, 'schedule_denied', 'Schedule permission is not granted')
}
const owner = (auth: AuthorizationContext) => auth.delegation?.by ?? auth.principal.id
function wake(env: L4Env, id: string) {
  return asRpc<{ wake: (id: string) => Promise<void> }>(env.AGENT_SCHEDULE_DO!.getByName(`schedule:${id}`)).wake(id)
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

/** The same admission checks a Run applies, so a work schedule is refused when it could never run. */
async function requireRunnableAgent(env: L4Env, agentId: string) {
  if (!await piConfigured(env)) fail(409, 'pi_unconfigured', 'Agent execution is unavailable. Ask the Server operator to check its configuration.')
  const profile = await env.DB.prepare("SELECT a.harness,a.status FROM agents a JOIN users u ON u.id=a.user_id WHERE a.user_id=? AND u.status='active'")
    .bind(agentId).first<{ harness: string; status: string }>()
  if (!profile || profile.harness !== 'pi' || profile.status !== 'active') fail(409, 'agent_unavailable', 'The agent is paused, removed or cannot run tasks')
}
async function requireOpenTask(env: L4Env, taskId: string, agentId: string) {
  const task = await env.DB.prepare('SELECT status,assignee_id as assigneeId,archived_at as archivedAt FROM tasks WHERE id=?')
    .bind(taskId).first<{ status: string; assigneeId: string | null; archivedAt: string | null }>()
  if (!task || task.archivedAt || task.status === 'done') fail(409, 'task_closed', 'The task is done, archived or deleted')
  if (task.assigneeId !== agentId) fail(403, 'task_reassigned', 'The task is no longer assigned to this agent')
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
      || !resourceAccessWithin(saved.delegation.resourceAccess ?? {}, current.delegation.resourceAccess)))) fail(403, 'schedule_revoked', 'A role or permission this schedule relies on was reduced')
  current.principal.permissions = saved.principal.permissions
  current.principal.resourceAccess = saved.principal.resourceAccess
  current.principal.isOwner = false
  if (current.delegation && saved.delegation) current.delegation = { ...saved.delegation, isOwner: false }
  if (current.principal.kind === 'agent') {
    const profile = await env.DB.prepare('SELECT status FROM agents WHERE user_id=?').bind(item.principalId).first<{ status: string }>()
    if (profile?.status !== 'active') fail(403, 'agent_unavailable', 'The agent that created this schedule is paused or removed')
  }
  requireGrant(current, Permission.manageSchedules)
  try { await scheduleMember(env, current, item.channelId) }
  catch (error) {
    const failure = scheduleFailure(error)
    if (failure.code === 'schedule_revoked' || failure.code === CHANNEL_ARCHIVED_CODE) throw error
    fail(failure.status, 'channel_unavailable', 'The conversation was removed or no longer accepts messages from this schedule')
  }
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
    await requireRunnableAgent(env, input.agentId!)
    const agent = await loadAuthorizationContext(env, { principalId: input.agentId!, credential: { kind: 'agent_runtime' },
      delegatedBy: auth.delegation?.by ?? auth.principal.id })
    if (!agent || agent.principal.kind !== 'agent' || !hasPermission(agent.principal.permissions, Permission.executeTasks)) fail(403, 'schedule_denied', 'Agent task execution is not granted')
    const task = await getTask(env, agent, input.taskId!)
    if (!task || task.assigneeId !== input.agentId) fail(403, 'schedule_denied', 'Task must be assigned to the selected agent')
    if (task.archivedAt || task.status === 'done') fail(409, 'task_closed', 'Choose an open task')
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
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?,? WHERE (SELECT count(*) FROM agent_schedules WHERE created_by=? AND status='active')<? RETURNING id`)
    .bind(id, auth.principal.id, owner(auth), input.channelId, input.kind, input.content, input.agentId ?? null, input.taskId ?? null,
      new Date(input.firstAt).toISOString(), input.timezone, input.recurrence, new Date(input.firstAt).toISOString(), JSON.stringify(auth), mandate ? JSON.stringify(mandate) : null,
      nowIso(), owner(auth), SCHEDULE_ACTIVE_LIMIT).first().then(row => { if (!row) fail(429, 'schedule_limit', `You already have ${SCHEDULE_ACTIVE_LIMIT} active schedules. Cancel one first.`) })
  await wake(env, id)
  return publicSchedule((await findSchedule(env, id))!)
}
export function publicSchedule(item: Schedule): PublicSchedule {
  const { authorizationJson: _authorization, mandateJson: _mandate, ...publicItem } = item
  return publicItem
}

const statusFilter: Record<z.infer<typeof scheduleListQuerySchema>['status'], string> = {
  current: "s.status IN ('active','blocked')", history: "s.status IN ('completed','cancelled')",
  active: "s.status='active' AND s.paused_at IS NULL", paused: "s.status='active' AND s.paused_at IS NOT NULL",
  blocked: "s.status='blocked'", completed: "s.status='completed'", cancelled: "s.status='cancelled'",
}
/**
 * Current schedules list blocked ones first, then by next run; history lists newest first.
 * The keyset cursor is `rank|sortAt|id`. A schedule whose conversation the viewer lost stays listed,
 * without its content, so it can still be cancelled.
 */
export async function listSchedules(env: L4Env, auth: AuthorizationContext, query: z.input<typeof scheduleListQuerySchema> = {}): Promise<ScheduleListPage> {
  requireGrant(auth, Permission.manageSchedules)
  const { status, cursor, limit } = scheduleListQuerySchema.parse(query)
  const ascending = !['history', 'completed', 'cancelled'].includes(status)
  const rank = ascending ? "(CASE WHEN s.status='blocked' THEN 0 ELSE 1 END)" : '0'
  const at = ascending ? "COALESCE(s.next_at,'~')" : 's.created_at'
  const direction = ascending ? 'ASC' : 'DESC'
  const after = cursor?.split('|')
  if (after && after.length !== 3) fail(400, 'bad_request', 'Invalid cursor')
  const rows = (await env.DB.prepare(`SELECT ${columns},${rank} as sortRank,${at} as sortAt FROM agent_schedules s
    WHERE (s.created_by=? OR s.principal_id=?) AND s.dismissed_at IS NULL AND ${statusFilter[status]}
    ${after ? `AND (${rank},${at},s.id) ${ascending ? '>' : '<'} (?,?,?)` : ''}
    ORDER BY sortRank ${direction},sortAt ${direction},s.id ${direction} LIMIT ?`)
    .bind(owner(auth), auth.principal.id, ...(after ? [Number(after[0]), after[1], after[2]] : []), limit + 1)
    .all<Schedule & { sortRank: number; sortAt: string }>()).results ?? []
  const page = rows.slice(0, limit)
  const schedules: PublicSchedule[] = []
  for (const { sortRank: _rank, sortAt: _at, ...row } of page) {
    try { await scheduleMember(env, auth, row.channelId); schedules.push(publicSchedule(row)) }
    catch { schedules.push({ ...publicSchedule(row), content: '', unavailable: true }) }
  }
  const last = page.at(-1)
  const active = await env.DB.prepare("SELECT count(*) as count FROM agent_schedules WHERE created_by=? AND status='active'").bind(owner(auth)).first<{ count: number }>()
  return { schedules, nextCursor: rows.length > limit && last ? `${last.sortRank}|${last.sortAt}|${last.id}` : null,
    activeCount: active?.count ?? 0, activeLimit: SCHEDULE_ACTIVE_LIMIT }
}

/** Owners manage their own schedules without current conversation access; stopping one only reduces capability. */
async function ownedSchedule(env: L4Env, auth: AuthorizationContext, id: string) {
  requireGrant(auth, Permission.manageSchedules)
  const item = await findSchedule(env, id)
  if (!item || (item.createdBy !== owner(auth) && item.principalId !== auth.principal.id)) fail(404, 'not_found', 'Schedule not found')
  return item
}
export async function cancelSchedule(env: L4Env, auth: AuthorizationContext, id: string) {
  await ownedSchedule(env, auth, id)
  const row = await env.DB.prepare("UPDATE agent_schedules SET status='cancelled',next_at=NULL,paused_at=NULL WHERE id=? AND status IN ('active','blocked') RETURNING id").bind(id).first()
  if (!row) fail(409, 'schedule_inactive', 'This schedule has already finished or been cancelled')
  await wake(env, id)
}
export async function pauseSchedule(env: L4Env, auth: AuthorizationContext, id: string) {
  await ownedSchedule(env, auth, id)
  const row = await env.DB.prepare("UPDATE agent_schedules SET paused_at=? WHERE id=? AND status='active' AND paused_at IS NULL RETURNING id").bind(nowIso(), id).first()
  if (!row) fail(409, 'schedule_inactive', 'Only an active schedule can be paused')
  await wake(env, id)
  return publicSchedule((await findSchedule(env, id))!)
}
/**
 * Resuming re-runs the delivery checks first, so a blocked schedule restarts only once its cause is fixed.
 * Missed repetitions are skipped; a one-time schedule whose time passed is delivered now.
 */
export async function resumeSchedule(env: L4Env, auth: AuthorizationContext, id: string) {
  const item = await ownedSchedule(env, auth, id)
  if (item.status !== 'paused' && item.status !== 'blocked') fail(409, 'schedule_inactive', 'Only a paused or blocked schedule can be resumed')
  await scheduleAuthorization(env, item)
  if (item.kind === 'work') {
    await requireRunnableAgent(env, item.agentId!)
    await requireOpenTask(env, item.taskId!, item.agentId!)
  }
  const due = item.nextAt ?? item.firstAt
  const nextAt = Date.parse(due) > Date.now() || item.recurrence === 'once' ? due : nextScheduleAt(item, due, nowIso())
  const [, resumed] = await env.DB.batch([
    env.DB.prepare('UPDATE agent_schedule_occurrences SET attempts=0,failed_at=NULL,last_error=NULL WHERE schedule_id=? AND due_at=? AND completed_at IS NULL').bind(id, nextAt),
    env.DB.prepare(`UPDATE agent_schedules SET status='active',paused_at=NULL,next_at=?,last_error=NULL,last_error_code=NULL
      WHERE id=? AND (status='blocked' OR (status='active' AND paused_at IS NOT NULL))
      AND (status='active' OR (SELECT count(*) FROM agent_schedules WHERE created_by=? AND status='active')<?) RETURNING id`)
      .bind(nextAt, id, item.createdBy, SCHEDULE_ACTIVE_LIMIT),
  ])
  if (!(resumed as D1Result | undefined)?.results?.length) {
    if (item.status === 'blocked') fail(429, 'schedule_limit', `You already have ${SCHEDULE_ACTIVE_LIMIT} active schedules. Cancel one first.`)
    fail(409, 'schedule_inactive', 'This schedule changed. Refresh and try again.')
  }
  await wake(env, id)
  return publicSchedule((await findSchedule(env, id))!)
}
export async function dismissSchedule(env: L4Env, auth: AuthorizationContext, id: string) {
  await ownedSchedule(env, auth, id)
  const row = await env.DB.prepare("UPDATE agent_schedules SET dismissed_at=? WHERE id=? AND status IN ('completed','cancelled') AND dismissed_at IS NULL RETURNING id").bind(nowIso(), id).first()
  if (!row) fail(409, 'schedule_active', 'Cancel the schedule before removing it')
}
export async function listScheduleOccurrences(env: L4Env, auth: AuthorizationContext, id: string, limit = 20): Promise<ScheduleOccurrence[]> {
  const item = await ownedSchedule(env, auth, id)
  const rows = await env.DB.prepare(`SELECT due_at as dueAt,message_id as messageId,run_id as runId,completed_at as completedAt,failed_at as failedAt,attempts,last_error as lastError
    FROM agent_schedule_occurrences WHERE schedule_id=? ORDER BY due_at DESC LIMIT ?`).bind(id, Math.min(Math.max(limit, 1), 100)).all<ScheduleOccurrence>()
  // A reminder's message id is reserved before delivery; link it only once delivered.
  return (rows.results ?? []).map(row => ({ ...row, messageId: item.kind === 'reminder' && row.completedAt ? row.messageId : null }))
}

export type ScheduleFailure = { status: number; code: string; message: string }
/** Keep a typed error's own code and message; anything else is reported generically, without internals. */
export function scheduleFailure(error: unknown): ScheduleFailure {
  const value = (error && typeof error === 'object' ? error : {}) as { statusCode?: unknown; statusMessage?: unknown; data?: { error?: { code?: unknown; message?: unknown } } }
  const status = typeof value.statusCode === 'number' ? value.statusCode : 500
  const code = typeof value.data?.error?.code === 'string' ? value.data.error.code : 'delivery_failed'
  const message = typeof value.data?.error?.message === 'string' ? value.data.error.message
    : status < 500 && typeof value.statusMessage === 'string' ? value.statusMessage : 'Delivery failed temporarily'
  return { status, code, message: message.slice(0, 500) }
}
/** These need a person to act before any later attempt can succeed. */
function blocksSchedule(failure: ScheduleFailure) {
  return failure.status === 403 || failure.status === 404
    || ['agent_unavailable', 'pi_unconfigured', 'model_unavailable', 'run_conflict', CHANNEL_ARCHIVED_CODE].includes(failure.code)
}
/**
 * Persist a failed attempt and return when to retry, or null when the schedule was blocked, completed or
 * advanced past a failed occurrence. A retry never runs into the next occurrence.
 */
export async function recordScheduleFailure(env: L4Env, item: Schedule, error: unknown, now = Date.now()): Promise<number | null> {
  const failure = scheduleFailure(error)
  if (failure.code === 'task_closed') {
    await env.DB.prepare("UPDATE agent_schedules SET status='completed',next_at=NULL,last_error=?,last_error_code=? WHERE id=? AND status='active'")
      .bind(failure.message, failure.code, item.id).run()
    return null
  }
  if (blocksSchedule(failure)) {
    await env.DB.prepare("UPDATE agent_schedules SET status='blocked',last_error=?,last_error_code=? WHERE id=? AND status='active'")
      .bind(failure.message, failure.code, item.id).run()
    return null
  }
  const stamp = new Date(now).toISOString()
  await env.DB.prepare('INSERT INTO agent_schedule_occurrences(schedule_id,due_at,message_id) VALUES (?,?,?) ON CONFLICT DO NOTHING').bind(item.id, item.nextAt, newId()).run()
  const attempt = await env.DB.prepare('UPDATE agent_schedule_occurrences SET attempts=attempts+1,last_error=? WHERE schedule_id=? AND due_at=? AND completed_at IS NULL RETURNING attempts')
    .bind(failure.message, item.id, item.nextAt).first<{ attempts: number }>()
  const following = nextScheduleAt(item, item.nextAt!, stamp)
  const delay = attempt ? SCHEDULE_RETRY_DELAYS[attempt.attempts - 1] : SCHEDULE_RETRY_DELAYS[0]
  if (delay && (!following || now + delay < Date.parse(following))) {
    await env.DB.prepare("UPDATE agent_schedules SET last_error=?,last_error_code=? WHERE id=? AND status='active' AND next_at=?")
      .bind(failure.message, failure.code, item.id, item.nextAt).run()
    return now + delay
  }
  await env.DB.batch([
    env.DB.prepare('UPDATE agent_schedule_occurrences SET failed_at=? WHERE schedule_id=? AND due_at=? AND completed_at IS NULL').bind(stamp, item.id, item.nextAt),
    env.DB.prepare("UPDATE agent_schedules SET next_at=?,status=?,last_error=?,last_error_code=? WHERE id=? AND status='active' AND next_at=?")
      .bind(following ?? item.nextAt, following ? 'active' : 'blocked', `Missed after ${attempt?.attempts ?? 1} attempts: ${failure.message}`, failure.code, item.id, item.nextAt),
  ])
  return null
}

export async function executeScheduledOccurrence(env: L4Env, item: Schedule, schedule: (promise: Promise<unknown>) => void) {
  if (item.status !== 'active' || !item.nextAt || Date.parse(item.nextAt) > Date.now()) return
  if (item.kind === 'work') await requireOpenTask(env, item.taskId!, item.agentId!)
  const authorization = await scheduleAuthorization(env, item)
  await env.DB.prepare('INSERT INTO agent_schedule_occurrences(schedule_id,due_at,message_id) VALUES (?,?,?) ON CONFLICT DO NOTHING')
    .bind(item.id, item.nextAt, newId()).run()
  const occurrence = await env.DB.prepare('SELECT message_id as messageId,completed_at as completedAt FROM agent_schedule_occurrences WHERE schedule_id=? AND due_at=?')
    .bind(item.id, item.nextAt).first<{ messageId: string; completedAt: string | null }>()
  let runId: string | null = null
  if (!occurrence!.completedAt) {
    if (item.kind === 'reminder') {
      // Sent as the creator, so mark it unread and notify them; message rules skip a sender.
      await sendChannelMessage(env, await scheduleMember(env, authorization, item.channelId), item.channelId,
        { content: `Reminder: ${item.content}` }, schedule, occurrence!.messageId, { notifyAgents: false, remindUserId: item.createdBy })
    } else {
      const human = authorization.principal.kind === 'human' ? authorization
        : await loadAuthorizationContext(env, { principalId: item.createdBy, credential: { kind: 'session' } })
      if (!human) fail(403, 'schedule_revoked', 'The schedule creator is no longer an active Member')
      runId = (await createAgentRun(env, human, { agentId: item.agentId!, taskId: item.taskId!, channelId: item.channelId,
        prompt: item.content, idempotencyKey: `schedule:${item.id}:${item.nextAt}` }, JSON.parse(item.mandateJson!) as RunMandate)).id
    }
  }
  const nextAt = nextScheduleAt(item, item.nextAt, nowIso())
  await env.DB.batch([
    env.DB.prepare('UPDATE agent_schedule_occurrences SET completed_at=COALESCE(completed_at,?),run_id=COALESCE(run_id,?),failed_at=NULL WHERE schedule_id=? AND due_at=?')
      .bind(nowIso(), runId, item.id, item.nextAt),
    env.DB.prepare("UPDATE agent_schedules SET next_at=?,status=?,last_error=NULL,last_error_code=NULL WHERE id=? AND status='active' AND next_at=?")
      .bind(nextAt, nextAt ? 'active' : 'completed', item.id, item.nextAt),
    env.DB.prepare(`DELETE FROM agent_schedule_occurrences WHERE schedule_id=? AND (completed_at IS NOT NULL OR failed_at IS NOT NULL)
      AND due_at NOT IN (SELECT due_at FROM agent_schedule_occurrences WHERE schedule_id=? ORDER BY due_at DESC LIMIT ?)`).bind(item.id, item.id, OCCURRENCE_RETENTION),
  ])
}
