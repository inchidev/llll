import { authorize, ServerAction } from '../../shared/authorization'
import { hasPermission, Permission } from '../../shared/permissions'
import { projectSubjectPermissionAllowed } from '../../shared/project-access'
import type { RunEnvironment } from '../../shared/code-environments'
import { computeCapabilities } from '../../shared/software-factory'
import { nowIso } from '../../shared/ids'
import type { L4Env } from '../../workers/env'
import { findAgentRun, runAuthorization } from './agent-run-service'
import { getTask } from './task-service'
import { requireRunReader } from './agent-tool-security'
import { fail } from './cf'

export const factoryHash = async (value: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('')
/** A Task's box as the outward actions see it: its branch, what it published and how much it ran. */
export type TaskBox = { id: string; channelId: string; taskId: string; agentId: string; initiatedBy: string; nodeId: string; environmentJson: string; status: string; runId: string | null
  leaseToken: string | null; checkpointSha: string | null; headSha: string | null; pullJson: string | null; pushedSha: string | null; runtimeMs: number; publicationCount: number; updatedAt: string
  /** The placement an L4 Compute box's own Node is under: the Node the repository names. */
  placementId: string | null; cloudBoxId: string | null }
export const taskBoxColumns = `id,channel_id AS channelId,task_id AS taskId,agent_id AS agentId,initiated_by AS initiatedBy,node_id AS nodeId,environment_json AS environmentJson,status,run_id AS runId,lease_token AS leaseToken,checkpoint_sha AS checkpointSha,head_sha AS headSha,pull_json AS pullJson,pushed_sha AS pushedSha,runtime_ms AS runtimeMs,publication_count AS publicationCount,updated_at AS updatedAt,
  (SELECT placement_id FROM compute_nodes WHERE id=factory_boxes.node_id) AS placementId,cloud_box_id AS cloudBoxId`
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
  const environment = JSON.parse(run.environmentJson) as RunEnvironment
  // The Task and the Node are independent reads.
  const [task, node] = await Promise.all([
    getTask(env, auth, run.taskId),
    environment.computeNodeId
      ? env.DB.prepare('SELECT name,enabled,capabilities_json AS capabilitiesJson,last_seen AS lastSeen FROM compute_nodes WHERE id=?').bind(environment.computeNodeId).first<{ name: string; enabled: number; capabilitiesJson: string; lastSeen: string | null }>()
      : null,
  ])
  if (!task || task.archivedAt || (!readOnly && task.status === 'done') || task.assigneeId !== run.agentId || task.environmentId !== environment.id) fail(403, 'factory_revoked', 'Task assignment or repository changed')
  if (!environment.computeNodeId) fail(409, 'compute_unconfigured', 'Choose a Compute Node for this repository in Server settings')
  if (!node) fail(403, 'compute_revoked', 'The Compute Node chosen for this repository was removed. Choose another one in Settings → Compute.')
  if (!readOnly && !node.enabled) fail(403, 'compute_revoked', `The Compute Node “${node.name}” is turned off. Turn it on in Settings → Compute, then retry.`)
  const capabilities = computeCapabilities.safeParse(JSON.parse(node.capabilitiesJson))
  if (!capabilities.success) fail(409, 'compute_unavailable', 'Connect a Docker Compute Node with a pinned box image')
  return { run, auth, task, environment, capabilities: capabilities.data, nodeLastSeen: node.lastSeen }
}
/**
 * The box of this Run's Task, Agent and initiator, if its first turn made one. It must still be the box of
 * this conversation, repository snapshot and Node: a Task whose mandate changed starts again in a new Task.
 */
export async function taskBox(env: L4Env, context: Awaited<ReturnType<typeof factoryAuthority>>) {
  const { run, environment } = context
  const box = await env.DB.prepare(`SELECT ${taskBoxColumns} FROM factory_boxes WHERE task_id=? AND agent_id=? AND initiated_by=?`).bind(run.taskId, run.agentId, run.initiatedBy).first<TaskBox>()
  if (box && (box.channelId !== run.channelId || box.environmentJson !== JSON.stringify(environment) || (box.nodeId !== environment.computeNodeId && box.placementId !== environment.computeNodeId))) fail(409, 'factory_base_changed', 'The Task’s box is pinned to a different repository snapshot. Review upstream changes and start a new Task.')
  return box
}
