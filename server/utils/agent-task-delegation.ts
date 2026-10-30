import type { AgentRun, RunMandate } from '../../shared/agent-execution'
import { autonomousExecution } from '../../shared/agent-execution-policy'
import { authorize, ServerAction, type AuthorizationContext } from '../../shared/authorization'
import { Permission } from '../../shared/permissions'
import { ProjectPolicyPermissions } from '../../shared/project-access'
import type { L4Env } from '../../workers/env'
import { loadAuthorizationContext } from './authorization'
import { createAgentRun, findAgentRun, runAuthorization } from './agent-run-service'
import { getTask } from './task-service'
import { fail } from './cf'

/** Delegation grants no authority to the coordinator's own tools. The selected
 * executor receives project-only authority under the original human's ceiling. */
export async function delegateProjectTask(env: L4Env, run: AgentRun, authorization: AuthorizationContext, taskId: string, attempt = 1, instructions = '') {
  authorize(authorization, ServerAction.delegateTasks)
  const mandate = JSON.parse(run.mandateJson) as RunMandate
  if (!mandate.projectId || !mandate.execution || !autonomousExecution(mandate.execution.mode)) fail(403, 'delegation_scope', 'Delegation requires a role-authorized project run')
  if ((mandate.depth ?? 0) >= mandate.execution.maxDepth) fail(409, 'task_depth', 'Delegation depth limit reached')
  const task = await getTask(env, authorization, taskId)
  if (!task || task.projectId !== mandate.projectId || !task.assigneeId || task.assigneeId === run.agentId || task.archivedAt || task.status === 'done') fail(403, 'delegation_scope', 'Choose active work assigned to another agent in this project')
  let ancestor: AgentRun | null = run
  for (let depth = 0; ancestor && depth <= 16; depth++) {
    if (ancestor.taskId === task.id) fail(409, 'task_cycle', 'A task cannot delegate back to an ancestor')
    if (ancestor.agentId === task.assigneeId) fail(409, 'agent_cycle', 'An agent cannot be invoked again in the same active delegation chain')
    const parentId: string | undefined = (JSON.parse(ancestor.mandateJson) as RunMandate).parentRunId
    ancestor = parentId ? await findAgentRun(env, parentId) : null
  }
  const human = await loadAuthorizationContext(env, { principalId: run.initiatedBy, credential: { kind: 'session' } })
  const target = await loadAuthorizationContext(env, { principalId: task.assigneeId, credential: { kind: 'agent_runtime' }, delegatedBy: run.initiatedBy })
  if (!human || target?.principal.kind !== 'agent') fail(403, 'delegation_revoked', 'The task executor or initiating person is unavailable')
  const cap: RunMandate = { ...mandate, rootRunId: mandate.rootRunId ?? run.id, parentRunId: run.id, rootDeadline: mandate.rootDeadline ?? run.deadline, depth: (mandate.depth ?? 0) + 1,
    agentPermissions: target.principal.permissions & (ProjectPolicyPermissions | Permission.sendMessages),
    agentProjectPolicies: target.principal.projectPolicies?.filter(grant => grant.projectId === mandate.projectId),
    agentResourceAccess: target.principal.resourceAccess,
    computer: true, environmentId: task.environmentId ?? null, environmentVersion: undefined, toolConnections: [] }
  const child = await createAgentRun(env, human, { agentId: task.assigneeId, channelId: run.channelId, taskId,
    prompt: `${task.title}\n\n${task.description}${instructions ? `\n\nDelegated instructions and review feedback:\n${instructions}` : ''}`, idempotencyKey: `delegate:${run.id}:${task.id}:${attempt}` }, cap)
  return { runId: child.id, taskId: task.id, agentId: child.agentId, status: child.status, message: 'Work is queued for the assigned agent under the same human mandate and shared budget. Use get_delegated_run to inspect its result; do not start duplicates.' }
}
export async function delegatedRunResult(env: L4Env, parent: AgentRun, childId: string) {
  await runAuthorization(env, parent)
  const child = await findAgentRun(env, childId)
  if (!child || (JSON.parse(child.mandateJson) as RunMandate).parentRunId !== parent.id || child.initiatedBy !== parent.initiatedBy) fail(404, 'not_found', 'Delegated run not found')
  await runAuthorization(env, child)
  return { runId: child.id, taskId: child.taskId, agentId: child.agentId, status: child.status, result: child.resultText, error: child.lastError }
}
