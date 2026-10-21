import { authorizeResource, type AuthorizationContext } from '../../shared/authorization'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { agents, channels, taskBoards, taskDependencies, taskLabels, taskNumbers, tasks, users } from '../../drizzle/schema'
import type { TaskStatus } from '../../shared/types'
import type { L4Env } from '../../workers/env'
import { fail } from './cf'
import { getDb } from './db'

export async function requireBoard(env: L4Env, boardId: string, authorization?: AuthorizationContext) {
  if (authorization) authorizeResource(authorization, 'boards', boardId)
  const row = (await getDb(env.DB).select().from(taskBoards).where(eq(taskBoards.id, boardId)).limit(1))[0]
  if (!row) fail(404, 'not_found', 'Board not found')
  return row
}

export async function requireTask(env: L4Env, taskReference: string | number, authorization?: AuthorizationContext) {
  const reference = String(taskReference).trim()
  let taskId = reference
  if (/^[1-9]\d*$/u.test(reference)) {
    const numbered = (await getDb(env.DB).select({ taskId: taskNumbers.taskId }).from(taskNumbers)
      .where(eq(taskNumbers.number, Number(reference))).limit(1))[0]
    taskId = numbered?.taskId ?? ''
  }
  const row = (await getDb(env.DB).select().from(tasks).where(eq(tasks.id, taskId)).limit(1))[0]
  if (!row) fail(404, 'not_found', 'Task not found')
  if (authorization) authorizeResource(authorization, 'boards', row.boardId)
  return row
}

/** A task can be assigned to any active member: a person, or an agent that is not paused. */
export async function validateTaskAssignee(env: L4Env, assigneeId: string | null | undefined) {
  if (!assigneeId) return
  const db = getDb(env.DB)
  const user = (await db.select({ kind: users.kind }).from(users)
    .where(and(eq(users.id, assigneeId), eq(users.status, 'active'))).limit(1))[0]
  if (!user) fail(400, 'bad_request', 'Active member not found')
  if (user.kind === 'agent') {
    const agent = (await db.select({ id: agents.userId }).from(agents)
      .where(and(eq(agents.userId, assigneeId), eq(agents.status, 'active'))).limit(1))[0]
    if (!agent) fail(400, 'bad_request', 'Active agent not found')
  }
}

export async function validateTaskChannel(env: L4Env, channelId: string | null | undefined) {
  if (!channelId) return
  const row = (await getDb(env.DB).select({ id: channels.id }).from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.type, 'text'), eq(channels.visibility, 'server'))).limit(1))[0]
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

export async function nextLabelPosition(env: L4Env, boardId: string): Promise<number> {
  const row = await getDb(env.DB).select({ value: sql<number>`coalesce(max(${taskLabels.position}), 0)` }).from(taskLabels)
    .where(eq(taskLabels.boardId, boardId))
  return Number(row[0]?.value ?? 0) + 1024
}

export async function nextBoardPosition(env: L4Env): Promise<number> {
  const row = await getDb(env.DB).select({ value: sql<number>`coalesce(max(${taskBoards.position}), 0)` }).from(taskBoards)
  return Number(row[0]?.value ?? 0) + 1024
}
