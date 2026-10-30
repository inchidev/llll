import { dispatchCloudflareFactory } from './factory-setup'
import { patchAgentTurn, fanoutAgentTurns } from '../../workers/agent-turns'
import { factoryRequest, parseFactoryToolInput, factorySnapshot, planRequest, type FactoryAction, type FactoryRequest } from '../../shared/software-factory'
import { newId, nowIso } from '../../shared/ids'
import type { L4Env } from '../../workers/env'
import { factoryAuthority, factoryHash, factoryWorkspace, type FactoryWorkspace, workspaceColumns } from './factory-authority'
import { findAgentRun } from './agent-run-service'
import { requireRunReader, markUntrustedContext } from './agent-tool-security'
import { fail } from './cf'
import { getTask } from './task-service'
import { authorize, ServerAction } from '../../shared/authorization'
import type { RunMandate } from '../../shared/agent-execution'

export type ActionRow = { id: string; workspaceId: string; runId: string; callId: string; digest: string; requestJson: string; policyJson: string; status: string; expiresAt: string; decidedBy: string | null; decidedAt: string | null; resultJson: string | null; createdAt: string; leaseToken: string | null; leaseUntil: string | null }
export const actionColumns = 'id,workspace_id AS workspaceId,run_id AS runId,call_id AS callId,digest,request_json AS requestJson,policy_json AS policyJson,status,expires_at AS expiresAt,decided_by AS decidedBy,decided_at AS decidedAt,result_json AS resultJson,created_at AS createdAt,lease_token AS leaseToken,lease_until AS leaseUntil'
export const visibleAction = (row: ActionRow): FactoryAction => ({ approvalMode: JSON.parse(row.policyJson).approvalMode ?? 'review', computeLimits: { cpu: JSON.parse(row.policyJson).compute.cpu ?? 1, memoryMiB: JSON.parse(row.policyJson).compute.memoryMiB ?? 1024, processes: JSON.parse(row.policyJson).compute.processLimit ?? 128, timeoutMs: JSON.parse(row.policyJson).compute.timeoutMs ?? 120000 }, diskBytes: JSON.parse(row.policyJson).compute.diskBytes, computeImage: JSON.parse(row.policyJson).compute.image, workspaceRevision: JSON.parse(row.policyJson).workspaceRevision, id: row.id, workspaceId: row.workspaceId, runId: row.runId, digest: row.digest, request: factoryRequest.parse(JSON.parse(row.requestJson)), status: row.status, expiresAt: row.expiresAt, decidedAt: row.decidedAt, decidedBy: row.decidedBy, result: row.resultJson ? JSON.parse(row.resultJson) : null, createdAt: row.createdAt })
export async function expireFactoryActions(env: L4Env) {
  await env.DB.batch([
    env.DB.prepare("UPDATE factory_actions SET status='expired' WHERE status IN ('pending','approved') AND expires_at<=?").bind(nowIso()),
    env.DB.prepare("UPDATE factory_actions SET status='uncertain' WHERE status IN ('claimed','executing') AND (lease_until<=? OR expires_at<=?)").bind(nowIso(), nowIso()),
    env.DB.prepare("UPDATE factory_actions SET status='cancelled' WHERE status IN ('pending','approved') AND run_id IN (SELECT id FROM agent_runs WHERE status<>'running' OR deadline<=?)").bind(nowIso()),
  ])
}
export async function authorizeFactoryAction(env: L4Env, row: ActionRow, actorId?: string) {
  const request = factoryRequest.parse(JSON.parse(row.requestJson))
  const context = await factoryAuthority(env, row.runId, actorId, request.operation === 'publish')
  if (request.operation === 'exec' && request.networkHosts.length) authorize(context.auth, ServerAction.browseWeb)
  const workspace = await env.DB.prepare(`SELECT ${workspaceColumns} FROM factory_workspaces WHERE id=?`).bind(row.workspaceId).first<FactoryWorkspace>()
  const savedPolicy = JSON.parse(row.policyJson)
  if (!workspace || workspace.channelId !== context.run.channelId || workspace.taskId !== context.run.taskId || workspace.agentId !== context.run.agentId || workspace.initiatedBy !== context.run.initiatedBy
    || workspace.environmentJson !== JSON.stringify(context.environment) || workspace.nodeId !== context.environment.computeNodeId
    || JSON.stringify(savedPolicy.auth) !== JSON.stringify(context.auth) || JSON.stringify(savedPolicy.compute) !== JSON.stringify(context.capabilities) || (['pending','approved','claimed','executing'].includes(row.status) && savedPolicy.workspaceRevision !== workspace.commands) || row.expiresAt <= nowIso()) fail(403, 'factory_revoked', 'Action scope, authority or expiry changed')
  if (request.operation === 'publish' && (!workspace.snapshotJson || await factoryHash(workspace.snapshotJson) !== request.snapshotDigest)) fail(409, 'factory_snapshot_changed', 'Review the new snapshot before publication')
  return { ...context, workspace, request }
}
/** The Task's current plan, if the person approved it, and how many operations it still covers.
 * Only the latest plan counts: proposing a new one pauses automatic approval until it is decided. */
export async function approvedPlan(env: L4Env, workspaceId: string) {
  const row = await env.DB.prepare(`SELECT request_json AS requestJson,status,decided_at AS decidedAt FROM factory_actions
    WHERE workspace_id=? AND json_extract(request_json,'$.operation')='plan' ORDER BY created_at DESC LIMIT 1`).bind(workspaceId).first<{ requestJson: string; status: string; decidedAt: string | null }>()
  if (!row || row.status !== 'completed' || !row.decidedAt) return null
  const used = await env.DB.prepare(`SELECT count(*) AS n FROM factory_actions WHERE workspace_id=? AND created_at>? AND json_extract(request_json,'$.operation')<>'plan'`)
    .bind(workspaceId, row.decidedAt).first<{ n: number }>()
  const plan = planRequest.parse(JSON.parse(row.requestJson))
  return { plan, remaining: plan.operations - (used?.n ?? 0) }
}
export function planCovers(approved: Awaited<ReturnType<typeof approvedPlan>>, request: FactoryRequest) {
  if (!approved || approved.remaining <= 0 || request.operation === 'publish' || request.operation === 'plan') return false
  return request.operation !== 'exec' || request.networkHosts.every(host => approved.plan.networkHosts.includes(host))
}
/** Every effect has an immutable receipt, current authorization and a single claim.
 * Role mandates preapprove operations; plan mandates preapprove what an approved plan covers;
 * review and legacy mandates wait for each one. */
export async function factoryToolCall(env: L4Env, runId: string, callId: string, input: unknown) {
  const request = parseFactoryToolInput(input)
  const context = await factoryAuthority(env, runId, undefined, request.operation === 'publish')
  if (request.operation === 'exec' && request.networkHosts.length) authorize(context.auth, ServerAction.browseWeb)
  const execution = (JSON.parse(context.run.mandateJson) as RunMandate).execution
  const isPlan = request.operation === 'plan'
  if (request.operation === 'exec' && request.timeoutMs > ('timeoutMs' in context.capabilities ? context.capabilities.timeoutMs : 120000)) fail(400, 'factory_timeout', 'Command timeout exceeds this provider’s configured execution limit')
  await markUntrustedContext(env, context.run)
  await expireFactoryActions(env)
  const encoded = JSON.stringify(request)
  let row = await env.DB.prepare(`SELECT ${actionColumns} FROM factory_actions WHERE run_id=? AND call_id=?`).bind(runId, callId).first<ActionRow>()
  if (row) {
    if (row.requestJson !== encoded) fail(409, 'factory_call_changed', 'A tool call identity cannot change its arguments')
    await authorizeFactoryAction(env, row)
    if (['completed','failed'].includes(row.status) && row.resultJson) return JSON.parse(row.resultJson)
    if (isPlan && row.status === 'rejected') return { factoryPending: false, actionId: row.id, status: row.status, message: 'The plan was rejected. Ask the person what to change, then propose a revised plan.' }
    if (!['pending', 'approved', 'claimed', 'executing'].includes(row.status)) return { factoryPending: false, actionId: row.id, status: row.status, message: 'This action did not complete. Inspect its outcome; it will not be replayed.' }
    if (row.status === 'approved' && request.operation !== 'publish') await dispatchCloudflareFactory(env, row.id, row.workspaceId, (await factoryWorkspace(env, context)).nodeId)
    return { factoryPending: true, actionId: row.id, status: row.status, reviewUrl: `/runs/${runId}` }
  }
  const workspace = await factoryWorkspace(env, context)
  const automatic = execution?.mode === 'role' || (execution?.mode === 'plan' && planCovers(await approvedPlan(env, workspace.id), request))
  if (!isPlan && !['release','suspend'].includes(request.operation) && (workspace.commands >= (execution?.workspaceActions ?? 50) || workspace.runtimeMs >= (execution?.workspaceRuntimeMs ?? 3600000) || workspace.publicationCount >= (execution?.workspacePublications ?? 10))) fail(429, 'factory_budget', 'Task workspace action, runtime or publication limit reached')
  if (request.operation === 'exec' && workspace.runtimeMs + request.timeoutMs > (execution?.workspaceRuntimeMs ?? 3600000)) fail(429, 'factory_budget', 'Command exceeds the remaining Task runtime budget')
  if (!isPlan && request.operation !== 'bootstrap' && request.operation !== 'release' && workspace.status !== 'ready') fail(409, 'workspace_unavailable', 'Bootstrap the workspace first')
  if (request.operation === 'bootstrap' && !['new', 'released'].includes(workspace.status)) fail(409, 'workspace_exists', 'The workspace already has a pinned checkout')
  if (request.operation === 'publish') {
    if (context.environment.sourceRepoId !== context.environment.workRepoId) fail(409, 'factory_fork_unavailable', 'MVP publication uses a dedicated branch in the original repository')
    if (!workspace.snapshotJson || await factoryHash(workspace.snapshotJson) !== request.snapshotDigest) fail(409, 'factory_snapshot_changed', 'Snapshot the exact committed changes before publication')
    factorySnapshot.parse(JSON.parse(workspace.snapshotJson))
  }
  // A plan waits for the person as long as the Run does; an operation review stays short.
  const id = newId(), expiresAt = new Date(isPlan ? Date.parse(context.run.deadline) : Math.min(Date.parse(context.run.deadline), Date.now() + 15 * 60000)).toISOString()
  const approvalMode = execution?.mode === 'role' ? 'role' : automatic ? 'plan' : 'review'
  const policy = JSON.stringify({ auth: context.auth, compute: context.capabilities, workspaceRevision: workspace.commands, approvalMode })
  const digest = await factoryHash(JSON.stringify({ id, workspaceId: workspace.id, runId, callId, request, policy, environment: context.environment, expiresAt }))
  const inserted = await env.DB.prepare(`INSERT INTO factory_actions(id,workspace_id,run_id,call_id,digest,request_json,policy_json,status,expires_at,created_at)
    SELECT ?,?,?,?,?,?,?,'pending',?,? WHERE (SELECT count(*) FROM factory_actions WHERE workspace_id=?)<? ON CONFLICT DO NOTHING RETURNING id`)
    .bind(id, workspace.id, runId, callId, digest, encoded, policy, expiresAt, nowIso(), workspace.id, execution?.workspaceActions ?? 100).first()
  if (!inserted) {
    const existing = await env.DB.prepare(`SELECT ${actionColumns} FROM factory_actions WHERE run_id=? AND call_id=?`).bind(runId, callId).first<ActionRow>()
    if (existing && existing.requestJson === encoded) return { factoryPending: true, actionId: existing.id, status: existing.status, reviewUrl: `/runs/${runId}` }
    fail(409, 'factory_pending', 'Review the existing action before requesting another operation')
  }
  // In role mode a plan is a record, not a gate.
  const planAccepted = isPlan && execution?.mode === 'role'
  if (planAccepted) await settlePlan(env, id, null)
  else if (automatic) await env.DB.prepare("UPDATE factory_actions SET status='approved',decided_by=NULL,decided_at=? WHERE id=? AND status='pending'").bind(nowIso(), id).run()
  const proceeding = automatic || planAccepted
  await env.DB.prepare('UPDATE tasks SET factory_state=? WHERE id=? AND assignee_id=?').bind(proceeding ? 'queued' : 'approval_pending', context.run.taskId, context.run.agentId).run()
  await patchAgentTurn(env, runId, proceeding ? { status: 'tool', detail: 'Using a tool' } : { status: 'waiting_approval', detail: 'Review required' })
  if (env.CHANNEL_DO) await fanoutAgentTurns(env, context.run.channelId, context.run.agentId).catch(() => undefined)
  if (planAccepted) return JSON.parse((await env.DB.prepare('SELECT result_json AS resultJson FROM factory_actions WHERE id=?').bind(id).first<{ resultJson: string }>())!.resultJson)
  if (automatic && request.operation !== 'publish') await dispatchCloudflareFactory(env, id, workspace.id, workspace.nodeId)
  if (automatic && request.operation === 'publish') {
    const { executeFactoryPublication } = await import('./factory-github')
    await executeFactoryPublication(env, id)
  }
  row = (await env.DB.prepare(`SELECT ${actionColumns} FROM factory_actions WHERE id=?`).bind(id).first<ActionRow>())!
  return { factoryPending: true, actionId: row.id, status: row.status, reviewUrl: `/runs/${runId}` }
}
export async function listFactoryActions(env: L4Env, runId: string, actorId: string) {
  const run = await findAgentRun(env, runId)
  if (!run) fail(404, 'not_found', 'Run not found')
  requireRunReader(run, actorId)
  const { runAuthorization } = await import('./agent-run-service')
  const auth = await runAuthorization(env, run)
  if (run.taskId) await getTask(env, auth, run.taskId)
  await expireFactoryActions(env)
  const actions = await env.DB.prepare(`SELECT ${actionColumns} FROM factory_actions WHERE workspace_id IN
    (SELECT id FROM factory_workspaces WHERE task_id=? AND agent_id=? AND initiated_by=?) ORDER BY created_at DESC LIMIT 100`).bind(run.taskId, run.agentId, actorId).all<ActionRow>()
  const workspace = await env.DB.prepare(`SELECT ${workspaceColumns} FROM factory_workspaces WHERE task_id=? AND agent_id=? AND initiated_by=?`).bind(run.taskId, run.agentId, actorId).first<FactoryWorkspace>()
  if (workspace && (workspace.channelId !== run.channelId || workspace.environmentJson !== run.environmentJson)) fail(403, 'factory_revoked', 'Workspace belongs to an earlier repository mandate')
  let recovery: unknown = null
  if (workspace && env.FACTORY_COMPUTE) {
    const node = await env.DB.prepare('SELECT capabilities_json AS capabilitiesJson FROM compute_nodes WHERE id=?').bind(workspace.nodeId).first<{ capabilitiesJson: string }>()
    if (node && JSON.parse(node.capabilitiesJson).provider === 'cloudflare-containers') {
      const state = await env.FACTORY_COMPUTE.getByName(`workspace:${workspace.id}`).fetch(`http://factory/state?workspace=${workspace.id}`)
      if (state.ok) recovery = await state.json()
    }
  }
  return { recovery, actions: actions.results.map(visibleAction), workspace: workspace ? { repository: JSON.parse(workspace.environmentJson).sourceRepo, baseBranch: JSON.parse(workspace.environmentJson).baseBranch, branch: 'l4-agent/' + workspace.id, connectionId: JSON.parse(workspace.environmentJson).gitConnectionId ?? 'deployment', taskId: workspace.taskId, agentId: workspace.agentId, initiatedBy: workspace.initiatedBy, id: workspace.id, status: workspace.status, nodeId: workspace.nodeId, commands: workspace.commands, runtimeMs: workspace.runtimeMs, publicationCount: workspace.publicationCount,
    snapshot: workspace.snapshotJson ? JSON.parse(workspace.snapshotJson) : null, snapshotDigest: workspace.snapshotJson ? await factoryHash(workspace.snapshotJson) : null, pull: workspace.pullJson ? JSON.parse(workspace.pullJson) : null } : null }
}
export async function decideFactoryAction(env: L4Env, runId: string, actorId: string, request: { id: string; digest: string; decision: 'approve' | 'reject' }, schedule?: (promise: Promise<unknown>) => void) {
  await expireFactoryActions(env)
  const row = await env.DB.prepare(`SELECT ${actionColumns} FROM factory_actions WHERE id=? AND run_id=?`).bind(request.id, runId).first<ActionRow>()
  if (!row || row.digest !== request.digest) fail(409, 'factory_changed', 'Review the exact action again')
  const context = await authorizeFactoryAction(env, row, actorId)
  if (row.status !== 'pending') return visibleAction(row)
  const updated = context.request.operation === 'plan' && request.decision === 'approve'
    ? await settlePlan(env, row.id, actorId)
    : await env.DB.prepare("UPDATE factory_actions SET status=?,decided_by=?,decided_at=? WHERE id=? AND status='pending' AND expires_at>? RETURNING id")
      .bind(request.decision === 'approve' ? 'approved' : 'rejected', actorId, nowIso(), row.id, nowIso()).first()
  if (!updated) fail(409, 'factory_settled', 'Action was already decided')
  await env.DB.prepare('UPDATE tasks SET factory_state=? WHERE id=? AND assignee_id=?').bind(request.decision === 'approve' ? 'queued' : 'rejected', context.run.taskId, context.run.agentId).run()
  await patchAgentTurn(env, runId, { status: 'tool', detail: 'Using a tool' })
  if (env.CHANNEL_DO) await fanoutAgentTurns(env, context.run.channelId, context.run.agentId).catch(() => undefined)
  if (request.decision === 'approve' && !['publish', 'plan'].includes(context.request.operation)) await dispatchCloudflareFactory(env, row.id, row.workspaceId, context.workspace.nodeId)
  if (request.decision === 'approve' && context.request.operation === 'publish') {
    const { executeFactoryPublication } = await import('./factory-github')
    const work = executeFactoryPublication(env, row.id)
    if (schedule) schedule(work.catch(() => undefined)); else await work
  }
  return visibleAction((await env.DB.prepare(`SELECT ${actionColumns} FROM factory_actions WHERE id=?`).bind(row.id).first<ActionRow>())!)
}

/** An approved plan completes at once: it is a decision, never work for a computer. */
async function settlePlan(env: L4Env, id: string, decidedBy: string | null) {
  const row = await env.DB.prepare('SELECT request_json AS requestJson FROM factory_actions WHERE id=?').bind(id).first<{ requestJson: string }>()
  const plan = planRequest.parse(JSON.parse(row!.requestJson))
  const result = JSON.stringify({ approved: true, operations: plan.operations, networkHosts: plan.networkHosts,
    message: decidedBy ? 'The person approved this plan. Operations it covers now run without separate review; publishing still waits for approval. Propose a new plan if the work changes.' : 'Plan recorded.' })
  return env.DB.prepare("UPDATE factory_actions SET status='completed',decided_by=?,decided_at=?,result_json=? WHERE id=? AND status='pending' AND expires_at>? RETURNING id")
    .bind(decidedBy, nowIso(), result, id, nowIso()).first()
}
