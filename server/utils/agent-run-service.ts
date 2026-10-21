import { newId, nowIso } from '../../shared/ids'
import { hasPermission, Permission } from '../../shared/permissions'
import { resourceAccessAllows, resourceAccessWithin, RESOURCE_KINDS, type ResourceAccess } from '../../shared/resource-access'
import type { AuthorizationContext } from '../../shared/authorization'
import { intersectResources, runRequestSchema, type AgentRun, type RunMandate, type RunRequest } from '../../shared/agent-execution'
import type { L4Env } from '../../workers/env'
import { asRpc, piRuntimeConfigured } from '../../workers/env'
import { loadAuthorizationContext } from './authorization'
import { requireChannelAccessForMember, requireMemberForUser } from './channel-access'
import { getTask } from './task-service'
import { fail } from './cf'
import { putAgentTurn, fanoutAgentTurns } from '../../workers/agent-turns'

const runColumns = `id, session_id as sessionId, agent_id as agentId, channel_id as channelId, initiated_by as initiatedBy,
 task_id as taskId, source_message_id as sourceMessageId, status, prompt, model, instructions, mandate_json as mandateJson, result_text as resultText,
 last_error as lastError, model_calls as modelCalls, total_tokens as totalTokens, event_cursor as eventCursor,
 deadline, created_at as createdAt, updated_at as updatedAt`

export function piConfigured(env: L4Env): boolean {
  return piRuntimeConfigured(env)
}
export async function findAgentRun(env: L4Env, id: string): Promise<AgentRun | null> {
  return env.DB.prepare(`SELECT ${runColumns} FROM agent_runs WHERE id = ?`).bind(id).first<AgentRun>()
}

/** Check both current authority and the immutable upper bound accepted for this Run. */
export async function runAuthorization(env: L4Env, run: Pick<AgentRun, 'id' | 'agentId' | 'channelId' | 'initiatedBy' | 'mandateJson'>): Promise<AuthorizationContext> {
  const auth = await loadAuthorizationContext(env, { principalId: run.agentId, credential: { kind: 'agent_runtime', id: run.id }, delegatedBy: run.initiatedBy })
  if (!auth || !auth.delegation) fail(403, 'run_revoked', 'Run authorization was revoked')
  const actor = await env.DB.prepare(`SELECT u.kind, r.permissions_bitmask as permissions FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=? AND u.status='active'`)
    .bind(run.initiatedBy).first<{ kind: string; permissions: number }>()
  if (!actor || actor.kind !== 'human' || (!auth.delegation.isOwner && !hasPermission(actor.permissions, Permission.useAgents))) fail(403, 'run_revoked', 'Agent access was revoked')
  const profile = await env.DB.prepare("SELECT status,harness FROM agents WHERE user_id=?").bind(run.agentId).first<{ status: string; harness: string }>()
  if (profile?.status !== 'active' || profile.harness !== 'pi') fail(403, 'run_revoked', 'Agent is paused')
  for (const id of [run.agentId, run.initiatedBy]) {
    const row = await env.DB.prepare("SELECT id,kind,display_name as displayName,avatar_r2_key as avatarR2Key FROM users WHERE id=? AND status='active'")
      .bind(id).first<{ id: string; kind: 'human' | 'agent'; displayName: string; avatarR2Key: string | null }>()
    if (!row) fail(403, 'run_revoked', 'Member unavailable')
    await requireChannelAccessForMember(env, requireMemberForUser(env, row, auth.serverId), run.channelId, Permission.sendMessages)
  }
  const mandate = JSON.parse(run.mandateJson) as RunMandate
  if ((auth.principal.permissions & mandate.agentPermissions) !== mandate.agentPermissions
    || (!auth.delegation.isOwner && ((auth.delegation.permissions! & mandate.permissions) !== mandate.permissions))
    || !resourceAccessWithin(mandate.agentResourceAccess ?? {}, auth.principal.resourceAccess)
    || !resourceAccessWithin(mandate.resourceAccess ?? {}, auth.delegation.resourceAccess)) {
    fail(403, 'run_revoked', 'Run permissions were reduced; start a new attempt with the current role')
  }
  const intersect = (current: ResourceAccess | undefined, cap: ResourceAccess | undefined): ResourceAccess =>
    Object.fromEntries(RESOURCE_KINDS.map(kind => [kind, current?.[kind] == null ? cap?.[kind] ?? null : current[kind]!.filter(id => resourceAccessAllows(cap, kind, id))]))
  auth.principal.permissions &= mandate.agentPermissions
  auth.principal.resourceAccess = intersect(auth.principal.resourceAccess, mandate.agentResourceAccess)
  auth.delegation.permissions = (auth.delegation.isOwner ? mandate.permissions : auth.delegation.permissions! & mandate.permissions)
  auth.delegation.isOwner = false
  auth.delegation.resourceAccess = intersect(auth.delegation.resourceAccess, mandate.resourceAccess)
  return auth
}

export async function createAgentRun(env: L4Env, actor: AuthorizationContext, request: RunRequest, ceiling?: RunMandate): Promise<AgentRun> {
  const input = runRequestSchema.parse(request)
  if (input.sourceMessageId) {
    const source = await env.DB.prepare('SELECT m.id FROM messages m JOIN channels c ON c.id=? WHERE m.id=? AND (m.channel_id=c.id OR c.parent_message_id=m.id)')
      .bind(input.channelId, input.sourceMessageId).first()
    if (!source) fail(404, 'not_found', 'Source message not found in this conversation')
  }
  if (actor.principal.kind !== 'human' || (!actor.principal.isOwner && !hasPermission(actor.principal.permissions, Permission.useAgents))) fail(403, 'forbidden', 'Cannot invoke agents')
  if (!piConfigured(env)) fail(409, 'pi_unconfigured', 'Configure a Pi execution provider before starting work')
  const previous = await env.DB.prepare('SELECT id FROM agent_runs WHERE agent_id=? AND initiated_by=? AND idempotency_key=?')
    .bind(input.agentId, actor.principal.id, input.idempotencyKey).first<{ id: string }>()
  if (previous) {
    const run = (await findAgentRun(env, previous.id))!
    if (run.channelId !== input.channelId || run.prompt !== input.prompt || run.taskId !== (input.taskId ?? null)) fail(409, 'run_conflict', 'Request key was already used for different work')
    await runAuthorization(env, run)
    return run
  }
  const profile = await env.DB.prepare(`SELECT a.harness,a.status,a.model,a.instructions FROM agents a JOIN users u ON u.id=a.user_id WHERE a.user_id=? AND u.status='active'`)
    .bind(input.agentId).first<{ harness: string; status: string; model: string; instructions: string }>()
  if (!profile || profile.harness !== 'pi' || profile.status !== 'active') fail(409, 'agent_unavailable', 'Choose an active Pi agent')
  const agent = await loadAuthorizationContext(env, { principalId: input.agentId, credential: { kind: 'agent_runtime' }, delegatedBy: actor.principal.id })
  if (!agent) fail(403, 'forbidden', 'Agent unavailable')
  const computer = Boolean(input.taskId && hasPermission(agent.principal.permissions, Permission.useComputer)
    && (actor.principal.isOwner || hasPermission(actor.principal.permissions, Permission.useComputer)))
  if (input.taskId) {
    if (!hasPermission(agent.principal.permissions, Permission.executeTasks) || (!actor.principal.isOwner && !hasPermission(actor.principal.permissions, Permission.executeTasks))) fail(403, 'forbidden', 'Task execution is not granted')
    const task = await getTask(env, agent, input.taskId)
    if (!task || task.assigneeId !== input.agentId) fail(403, 'forbidden', 'Task must be assigned to this agent')
  }
  const now = nowIso()
  const sessionId = newId()
  await env.DB.prepare('INSERT INTO agent_sessions (id,agent_id,channel_id,created_at,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(agent_id,channel_id) DO NOTHING')
    .bind(sessionId, input.agentId, input.channelId, now, now).run()
  const session = await env.DB.prepare('SELECT id FROM agent_sessions WHERE agent_id=? AND channel_id=?').bind(input.agentId, input.channelId).first<{ id: string }>()
  const id = newId()
  const mandate: RunMandate = { permissions: actor.principal.permissions, resourceAccess: actor.principal.resourceAccess,
    agentPermissions: agent.principal.permissions, agentResourceAccess: agent.principal.resourceAccess,
    computer, maxSteps: 20, maxModelCalls: 20, maxToolCalls: 100, maxTokens: 64000 }
  if (ceiling) {
    mandate.depth = ceiling.depth ?? 0
    mandate.permissions &= ceiling.permissions
    mandate.agentPermissions &= ceiling.agentPermissions
    mandate.resourceAccess = intersectResources(mandate.resourceAccess, ceiling.resourceAccess)
    mandate.agentResourceAccess = intersectResources(mandate.agentResourceAccess, ceiling.agentResourceAccess)
    mandate.computer &&= ceiling.computer
    mandate.maxSteps = Math.min(mandate.maxSteps, ceiling.maxSteps)
    mandate.maxModelCalls = Math.min(mandate.maxModelCalls, ceiling.maxModelCalls)
    mandate.maxToolCalls = Math.min(mandate.maxToolCalls, ceiling.maxToolCalls)
    mandate.maxTokens = Math.min(mandate.maxTokens, ceiling.maxTokens)
  }
  // Admission checks source conversation access before creating an executable record.
  const pending = { id, agentId: input.agentId, channelId: input.channelId, initiatedBy: actor.principal.id, mandateJson: JSON.stringify(mandate) }
  await runAuthorization(env, pending)
  const admitted = await env.DB.prepare(`INSERT INTO agent_runs (id,session_id,agent_id,channel_id,initiated_by,task_id,source_message_id,idempotency_key,status,prompt,model,instructions,mandate_json,deadline,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,?,'queued',?,?,?,?,?,?,? WHERE (SELECT count(*) FROM agent_runs WHERE agent_id=? AND created_at>=?)<50
    ON CONFLICT(agent_id,initiated_by,idempotency_key) DO NOTHING RETURNING id`)
    .bind(id, session!.id, input.agentId, input.channelId, actor.principal.id, input.taskId ?? null, input.sourceMessageId ?? null, input.idempotencyKey,
      input.prompt, profile.model, profile.instructions, JSON.stringify(mandate), new Date(Date.now() + 15 * 60_000).toISOString(), now, now, input.agentId, new Date(Date.now() - 86400000).toISOString()).first<{ id: string }>()
  if (!admitted) {
    const duplicate = await env.DB.prepare('SELECT id FROM agent_runs WHERE agent_id=? AND initiated_by=? AND idempotency_key=?').bind(input.agentId, actor.principal.id, input.idempotencyKey).first<{ id: string }>()
    if (duplicate) return (await findAgentRun(env, duplicate.id))!
    fail(429, 'run_budget', 'Agent daily run limit reached')
  }
  if (input.sourceMessageId) {
    await putAgentTurn(env, { submissionId: id, agentId: input.agentId, channelId: input.channelId, sourceMessageId: input.sourceMessageId,
      initiatedBy: actor.principal.id, status: 'queued', detail: 'Queued' })
    await fanoutAgentTurns(env, input.channelId, input.agentId)
  }
  await asRpc<{ wake: (id: string) => Promise<void> }>(env.AGENT_RUN_DO!.getByName(`run:${id}`)).wake(id)
  return (await findAgentRun(env, id))!
}

export async function runCapability(env: L4Env, runId: string): Promise<string> {
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) throw new Error('Run signing secret unavailable')
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.AUTH_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`agent-run:${runId}`)))
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function verifyRunCapability(env: L4Env, runId: string, token: string): Promise<boolean> {
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) return false
  if (!/^[0-9a-f]{64}$/u.test(token)) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.AUTH_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  const signature = Uint8Array.from(token.match(/../gu)!, byte => Number.parseInt(byte, 16))
  return crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(`agent-run:${runId}`))
}
