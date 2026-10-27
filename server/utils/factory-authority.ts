import { authorize, ServerAction } from '../../shared/authorization'
import { hasPermission, Permission } from '../../shared/permissions'
import { projectSubjectPermissionAllowed } from '../../shared/project-access'
import type { RunEnvironment } from '../../shared/code-environments'
import { computeCapabilities } from '../../shared/software-factory'
import { newId, nowIso } from '../../shared/ids'
import type { L4Env } from '../../workers/env'
import { findAgentRun, runAuthorization } from './agent-run-service'
import { getTask } from './task-service'
import { requireRunReader } from './agent-tool-security'
import { fail } from './cf'

export const factoryHash = async (value: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('')
export type FactoryWorkspace = { id: string; channelId: string; taskId: string; agentId: string; initiatedBy: string; nodeId: string; environmentJson: string; originRunId: string; status: string; snapshotJson: string | null; pullJson: string | null; commands: number; runtimeMs: number; publicationCount: number }
export const workspaceColumns = 'id,channel_id AS channelId,task_id AS taskId,agent_id AS agentId,initiated_by AS initiatedBy,node_id AS nodeId,environment_json AS environmentJson,origin_run_id AS originRunId,status,snapshot_json AS snapshotJson,pull_json AS pullJson,commands,runtime_ms AS runtimeMs,publication_count AS publicationCount'
export async function factoryAuthority(env: L4Env, runId: string, actorId?: string, publication = false, readOnly = false) {
  const run = await findAgentRun(env, runId)
  if (!run) fail(404, 'not_found', 'Run not found')
  if (actorId) requireRunReader(run, actorId)
  if ((!readOnly && (run.status !== 'running' || run.deadline <= nowIso())) || !run.taskId || !run.environmentJson) fail(403, 'factory_inactive', 'Factory operations need an active Task Run with a repository')
  const mandate = JSON.parse(run.mandateJson)
  if (!mandate.computer) fail(403, 'factory_denied', 'Computer access was not delegated to this Run')
  const auth = await runAuthorization(env, run)
  authorize(auth, ServerAction.useComputer)
  if (publication) authorize(auth, ServerAction.proposeCode)
  if (actorId && !readOnly && !(auth.projectScope && auth.delegation ? projectSubjectPermissionAllowed(auth.delegation, auth.projectScope.id, Permission.approveAgentActions) : hasPermission(auth.delegation?.permissions ?? 0, Permission.approveAgentActions))) fail(403, 'factory_approval_denied', 'Approve Agent actions is required')
  const task = await getTask(env, auth, run.taskId)
  const environment = JSON.parse(run.environmentJson) as RunEnvironment
  if (!task || task.archivedAt || (!readOnly && task.status === 'done') || task.assigneeId !== run.agentId || task.environmentId !== environment.id) fail(403, 'factory_revoked', 'Task assignment or repository changed')
  if (!environment.computeNodeId) fail(409, 'compute_unconfigured', 'Choose a Compute Node for this repository in Server settings')
  const node = await env.DB.prepare('SELECT enabled,capabilities_json AS capabilitiesJson,last_seen AS lastSeen FROM compute_nodes WHERE id=?').bind(environment.computeNodeId).first<{ enabled: number; capabilitiesJson: string; lastSeen: string | null }>()
  if (!node || (!readOnly && !node.enabled)) fail(403, 'compute_revoked', 'Compute Node is disabled or unavailable')
  const capabilities = computeCapabilities.safeParse(JSON.parse(node.capabilitiesJson))
  if (!capabilities.success) fail(409, 'compute_unavailable', 'Connect a Docker Compute Node with a pinned workspace image')
  return { run, auth, task, environment, capabilities: capabilities.data, nodeLastSeen: node.lastSeen }
}
export async function factoryWorkspace(env: L4Env, context: Awaited<ReturnType<typeof factoryAuthority>>) {
  const { run, environment } = context
  await env.DB.prepare(`INSERT INTO factory_workspaces(id,channel_id,task_id,agent_id,initiated_by,node_id,environment_json,origin_run_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(task_id,agent_id,initiated_by) DO NOTHING`)
    .bind(newId(), run.channelId, run.taskId, run.agentId, run.initiatedBy, environment.computeNodeId, JSON.stringify(environment), run.id, nowIso(), nowIso()).run()
  const workspace = (await env.DB.prepare(`SELECT ${workspaceColumns} FROM factory_workspaces WHERE task_id=? AND agent_id=? AND initiated_by=?`).bind(run.taskId, run.agentId, run.initiatedBy).first<FactoryWorkspace>())!
  if (workspace.channelId !== run.channelId || workspace.environmentJson !== JSON.stringify(environment) || workspace.nodeId !== environment.computeNodeId) fail(409, 'factory_base_changed', 'The workspace is pinned to a different repository snapshot. Review upstream changes and start a new Task.')
  return workspace
}
