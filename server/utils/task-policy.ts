import { requireProject } from './project-service'
import { authorizeMcpCredential, authorizeResource, resourceAllowed, ServerAction, type AuthorizationContext } from '../../shared/authorization'
import { hasPermission, Permission, type PermissionFlag } from '../../shared/permissions'
import { projectPermissionAllowed } from '../../shared/project-access'
import { reachableSpaceIds, spaceResourceDenied } from '../../shared/spaces'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { agents, channels, taskBoards, taskDependencies, taskLabels, tasks, users } from '../../drizzle/schema'
import type { TaskStatus } from '../../shared/types'
import type { L4Env } from '../../workers/env'
import { fail } from './cf'
import { getDb } from './db'
import { spaceMembersOnly } from './space-access'

export async function requireBoard(env: L4Env, boardId: string, authorization?: AuthorizationContext) {
  // Decided without the boundary, so a board in another Space answers as a missing one does.
  if (authorization) authorizeResource(authorization, 'boards', boardId)
  const row = (await getDb(env.DB).select().from(taskBoards).where(eq(taskBoards.id, boardId)).limit(1))[0]
  if (!row || (authorization && spaceResourceDenied(authorization, 'boards', boardId))) fail(404, 'not_found', 'Board not found')
  return row
}

/** The board a Task goes on. Permission is the Task's own check; only the boundary applies here. */
export async function requireBoardInBoundary(env: L4Env, auth: AuthorizationContext, boardId: string) {
  const row = await requireBoard(env, boardId)
  if (spaceResourceDenied(auth, 'boards', boardId)) fail(404, 'not_found', 'Board not found')
  return row
}

/** A Task's project and its board are in one Space. */
export async function requireTaskSpace(env: L4Env, boardId: string, projectId: string | null | undefined) {
  if (!projectId) return
  const same = await env.DB.prepare('SELECT 1 AS ok FROM task_boards b JOIN projects p ON p.space_id = b.space_id WHERE b.id = ? AND p.id = ?').bind(boardId, projectId).first()
  if (!same) fail(400, 'bad_request', 'A Task and its project must be in the same Space')
}

export function taskPermissionAllowed(auth: AuthorizationContext, task: { projectId?: string | null; boardId: string }, flag: PermissionFlag): boolean {
  if (spaceResourceDenied(auth, 'boards', task.boardId)) return false
  const read = flag === Permission.readTasks
  try { authorizeMcpCredential(auth, read ? 'tasks:read' : 'tasks:write') } catch { return false }
  if (auth.delegation?.actions && !auth.delegation.actions.includes(read ? ServerAction.readTasks : ServerAction.writeTasks)) return false
  if (auth.projectScope && task.projectId !== auth.projectScope.id) return false
  if (task.projectId) return projectPermissionAllowed(auth, task.projectId, Permission.readProjects)
    && projectPermissionAllowed(auth, task.projectId, flag, { kind: 'boards', id: task.boardId })
  return (auth.principal.isOwner || hasPermission(auth.principal.permissions, flag))
    && (!auth.delegation || auth.delegation.isOwner || hasPermission(auth.delegation.permissions ?? 0, flag))
    && resourceAllowed(auth, 'boards', task.boardId)
}
export function requireTaskPermission(auth: AuthorizationContext, task: { projectId?: string | null; boardId: string }, flag: PermissionFlag) {
  if (!taskPermissionAllowed(auth, task, flag)) fail(403, 'task_denied', 'This task does not grant the requested operation')
}
/**
 * The Task a UUID or number means to this viewer, or null. Each Space has its own numbers, so a number
 * means a Task in a Space the viewer reaches, the active one first. Without a viewer it means nothing.
 */
export async function taskIdFromReference(env: L4Env, taskReference: string | number, authorization?: AuthorizationContext): Promise<string | null> {
  const reference = String(taskReference).trim()
  if (!/^[1-9]\d*$/u.test(reference)) return reference
  if (!authorization) return null
  const spaceIds = reachableSpaceIds(authorization)
  const rows = (await env.DB.prepare('SELECT task_id AS taskId, space_id AS spaceId FROM task_numbers WHERE number = ? AND space_id IN (SELECT value FROM json_each(?)) ORDER BY space_id')
    .bind(Number(reference), JSON.stringify(spaceIds)).all<{ taskId: string; spaceId: string }>()).results ?? []
  return (rows.find(row => row.spaceId === authorization.spaces?.active) ?? rows[0])?.taskId ?? null
}

export async function requireTask(env: L4Env, taskReference: string | number, authorization?: AuthorizationContext, flag: PermissionFlag = Permission.readTasks) {
  const taskId = await taskIdFromReference(env, taskReference, authorization) ?? ''
  const row = (await getDb(env.DB).select().from(tasks).where(eq(tasks.id, taskId)).limit(1))[0]
  if (!row || (authorization && spaceResourceDenied(authorization, 'boards', row.boardId))) fail(404, 'not_found', 'Task not found')
  if (authorization) {
    requireTaskPermission(authorization, row, flag)
    if (row.projectId) await requireProject(env, authorization, row.projectId)
  }
  return row
}

/** A task can be assigned to any active member of its Space: a person, or an agent that is not paused. */
export async function validateTaskAssignee(env: L4Env, assigneeId: string | null | undefined, spaceId: string) {
  if (!assigneeId) return
  const db = getDb(env.DB)
  const user = (await db.select({ kind: users.kind }).from(users)
    .where(and(eq(users.id, assigneeId), eq(users.status, 'active'))).limit(1))[0]
  if (!user || !await spaceMembersOnly(env, spaceId, [assigneeId])) fail(400, 'bad_request', 'Active member not found')
  if (user.kind === 'agent') {
    const agent = (await db.select({ status: agents.status }).from(agents).where(eq(agents.userId, assigneeId)).limit(1))[0]
    if (!agent) fail(400, 'bad_request', 'Active agent not found')
    if (agent.status !== 'active') fail(400, 'bad_request', 'This agent is paused. Resume it in Agents before assigning it tasks.')
  }
}

export async function validateTaskChannel(env: L4Env, channelId: string | null | undefined, spaceId: string) {
  if (!channelId) return
  const row = (await getDb(env.DB).select({ id: channels.id }).from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.type, 'text'), eq(channels.visibility, 'server'), eq(channels.spaceId, spaceId))).limit(1))[0]
  if (!row) fail(400, 'bad_request', 'Public text report channel not found')
}

export async function validateTaskLabels(env: L4Env, boardId: string, labelIds: string[] | undefined) {
  if (labelIds === undefined || labelIds.length === 0) return
  const unique = [...new Set(labelIds)]
  const rows = await getDb(env.DB).select({ id: taskLabels.id }).from(taskLabels)
    .where(and(eq(taskLabels.boardId, boardId), inArray(taskLabels.id, unique)))
  if (rows.length !== unique.length) fail(400, 'bad_request', 'Task labels must belong to the selected board')
}

export async function validateTaskDependencies(
  env: L4Env,
  taskId: string | null,
  boardId: string,
  dependencyIds: string[] | undefined,
) {
  if (dependencyIds === undefined || dependencyIds.length === 0) return
  const unique = [...new Set(dependencyIds)]
  if (taskId && unique.includes(taskId)) fail(400, 'bad_request', 'A task cannot depend on itself')
  const rows = await getDb(env.DB).select({ id: tasks.id }).from(tasks)
    .where(and(eq(tasks.boardId, boardId), inArray(tasks.id, unique)))
  if (rows.length !== unique.length) fail(400, 'bad_request', 'Dependencies must be tasks on the selected board')
  if (!taskId) return

  const edges = await getDb(env.DB).select().from(taskDependencies)
  const graph = new Map<string, string[]>()
  for (const edge of edges) {
    const list = graph.get(edge.taskId) ?? []
    list.push(edge.dependsOnTaskId)
    graph.set(edge.taskId, list)
  }
  graph.set(taskId, unique)
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    visiting.add(id)
    if ((graph.get(id) ?? []).some(visit)) return true
    visiting.delete(id)
    visited.add(id)
    return false
  }
  if (visit(taskId)) fail(400, 'bad_request', 'Task dependencies cannot contain a cycle')
}

export async function nextTaskPosition(env: L4Env, boardId: string, status: TaskStatus): Promise<number> {
  const row = await getDb(env.DB).select({ value: sql<number>`coalesce(max(${tasks.position}), 0)` }).from(tasks)
    .where(and(eq(tasks.boardId, boardId), eq(tasks.status, status)))
  return Number(row[0]?.value ?? 0) + 1024
}

/** Above everything in this column, for a Task that should be seen first. */
export async function firstTaskPosition(env: L4Env, boardId: string, status: TaskStatus): Promise<number> {
  const row = await getDb(env.DB).select({ value: sql<number>`coalesce(min(${tasks.position}), 1024)` }).from(tasks)
    .where(and(eq(tasks.boardId, boardId), eq(tasks.status, status)))
  return Number(row[0]?.value ?? 1024) - 1024
}

export async function nextLabelPosition(env: L4Env, boardId: string): Promise<number> {
  const row = await getDb(env.DB).select({ value: sql<number>`coalesce(max(${taskLabels.position}), 0)` }).from(taskLabels)
    .where(eq(taskLabels.boardId, boardId))
  return Number(row[0]?.value ?? 0) + 1024
}

export async function nextBoardPosition(env: L4Env, spaceId: string): Promise<number> {
  const row = await getDb(env.DB).select({ value: sql<number>`coalesce(max(${taskBoards.position}), 0)` }).from(taskBoards).where(eq(taskBoards.spaceId, spaceId))
  return Number(row[0]?.value ?? 0) + 1024
}
