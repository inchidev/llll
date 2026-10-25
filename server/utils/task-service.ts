import { authorizeResource as requireResource } from '../../shared/authorization'
import { findCodeEnvironment } from './code-environment-service'
import { fail } from './cf'
import { getServerId } from '../../shared/server-id'
import { and, eq, or } from 'drizzle-orm'
import { taskDependencies, taskLabelLinks, tasks } from '../../drizzle/schema'
import { newId, nowIso } from '../../shared/ids'
import type { TaskBoardDTO, TaskDetailDTO, TaskPriority, TaskStatus } from '../../shared/types'
import type { L4Env } from '../../workers/env'
import { signalTasksChanged } from '../../workers/task-events'
import { getDb } from './db'
import { writeAudit } from './messages'
import { authorize, authorizeResource, resourceAllowed, ServerAction, type AuthorizationContext } from '../../shared/authorization'
import { loadTaskBoards, loadTaskDetail } from './task-data'
import { nextTaskPosition, requireBoard, requireTask, validateTaskAssignee, validateTaskChannel, validateTaskDependencies, validateTaskLabels } from './task-policy'

async function validateEnvironment(env: L4Env, auth: AuthorizationContext, id: string | null | undefined) {
  if (!id) return
  const item = await findCodeEnvironment(env, id)
  if (!item?.enabled) fail(403, 'code_revoked', 'Repository environment is unavailable')
  requireResource(auth, 'repositories', String(item.sourceRepoId))
}

type Schedule = (promise: Promise<unknown>) => void

export type CreateTaskInput = {
  title: string
  description: string
  priority: TaskPriority
  dueAt: string | null
  assigneeId: string | null
  channelId: string | null
  environmentId?: string | null
  labelIds: string[]
  dependencyIds: string[]
}

export type UpdateTaskInput = {
  title?: string
  description?: string
  status?: TaskStatus
  priority?: TaskPriority
  dueAt?: string | null
  position?: number
  boardId?: string
  assigneeId?: string | null
  channelId?: string | null
  environmentId?: string | null
  archived?: boolean
  labelIds?: string[]
  dependencyIds?: string[]
}

export async function listTasks(
  env: L4Env,
  authorization: AuthorizationContext,
  includeArchived = false,
): Promise<TaskBoardDTO[]> {
  authorize(authorization, ServerAction.readTasks)
  return (await loadTaskBoards(env, includeArchived)).filter(board => resourceAllowed(authorization, 'boards', board.id))
}

export async function getTask(
  env: L4Env,
  authorization: AuthorizationContext,
  taskReference: string | number,
): Promise<TaskDetailDTO | null> {
  authorize(authorization, ServerAction.readTasks)
  const task = await loadTaskDetail(env, taskReference)
  if (task) authorizeResource(authorization, 'boards', task.boardId)
  return task
}

export async function createTask(
  env: L4Env,
  authorization: AuthorizationContext,
  boardId: string,
  input: CreateTaskInput,
  schedule: Schedule,
): Promise<TaskDetailDTO> {
  authorize(authorization, ServerAction.writeTasks)
  authorizeResource(authorization, 'boards', boardId)
  const actorId = authorization.principal.id
  const db = getDb(env.DB)
  await Promise.all([
    requireBoard(env, boardId),
    validateTaskAssignee(env, input.assigneeId),
    validateTaskChannel(env, input.channelId),
    validateEnvironment(env, authorization, input.environmentId),
    validateTaskLabels(env, boardId, input.labelIds),
    validateTaskDependencies(env, null, boardId, input.dependencyIds),
  ])
  const id = newId()
  const now = nowIso()
  const status = input.assigneeId ? 'ready' as const : 'backlog' as const
  const task = {
    id,
    boardId,
    title: input.title,
    description: input.description,
    status,
    priority: input.priority,
    dueAt: input.dueAt,
    position: await nextTaskPosition(env, boardId, status),
    assigneeId: input.assigneeId,
    channelId: input.channelId,
    environmentId: input.environmentId ?? null,
    createdBy: actorId,
    resultSummary: null,
    resultDetails: null,
    lastError: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  }
  await db.batch([
    db.insert(tasks).values(task),
    ...[...new Set(input.labelIds)].map(labelId => db.insert(taskLabelLinks).values({ taskId: id, labelId })),
    ...[...new Set(input.dependencyIds)].map(dependsOnTaskId => db.insert(taskDependencies).values({ taskId: id, dependsOnTaskId, createdAt: now })),
  ])
  await writeAudit(env, { serverId: (await getServerId(env.DB)), actorId, action: 'task.create', targetType: 'task', targetId: id, meta: { boardId, assigneeId: input.assigneeId }, authorization })
  schedule(signalTasksChanged(env, boardId, id))
  return (await loadTaskDetail(env, id))!
}

export async function updateTask(
  env: L4Env,
  authorization: AuthorizationContext,
  taskReference: string | number,
  input: UpdateTaskInput,
  schedule: Schedule,
): Promise<TaskDetailDTO> {
  authorize(authorization, ServerAction.writeTasks)
  const actorId = authorization.principal.id
  const db = getDb(env.DB)
  const task = await requireTask(env, taskReference)
  const id = task.id
  const boardId = input.boardId ?? task.boardId
  authorizeResource(authorization, 'boards', task.boardId)
  authorizeResource(authorization, 'boards', boardId)
  await Promise.all([
    input.boardId ? requireBoard(env, input.boardId) : Promise.resolve(),
    validateTaskAssignee(env, input.assigneeId),
    validateTaskChannel(env, input.channelId),
    validateEnvironment(env, authorization, input.environmentId),
    validateTaskLabels(env, boardId, input.labelIds),
    validateTaskDependencies(env, id, boardId, input.dependencyIds),
  ])

  let status = input.status ?? task.status
  if (input.status === undefined && input.assigneeId !== undefined) {
    if (input.assigneeId === null) status = 'backlog'
    else if (task.status === 'backlog') status = 'ready'
  }
  const position = input.position ?? (input.boardId || input.status ? await nextTaskPosition(env, boardId, status as TaskStatus) : task.position)
  const updatedAt = nowIso()
  const patch: Partial<typeof tasks.$inferInsert> = {
    title: input.title ?? task.title,
    description: input.description ?? task.description,
    status: status as TaskStatus,
    priority: input.priority ?? task.priority,
    dueAt: input.dueAt === undefined ? task.dueAt : input.dueAt,
    position,
    boardId,
    assigneeId: input.assigneeId === undefined ? task.assigneeId : input.assigneeId,
    channelId: input.channelId === undefined ? task.channelId : input.channelId,
    environmentId: input.environmentId === undefined ? task.environmentId : input.environmentId,
    archivedAt: input.archived === undefined ? task.archivedAt : input.archived ? updatedAt : null,
    lastError: status === 'failed' ? task.lastError : null,
    updatedAt,
  }

  // Compare the version read above so a concurrent edit cannot be overwritten.
  const update = db.update(tasks).set(patch).where(and(eq(tasks.id, id), eq(tasks.updatedAt, task.updatedAt))).toSQL()
  const statement = env.DB.prepare(update.sql).bind(...update.params)
  let changed: number | undefined
  if (authorization.credential.kind === 'agent_runtime' && authorization.credential.id) {
    // Advance only this Run's assigned-task cursor, and only across its own
    // uninterrupted edits. A human/other Run edit breaks the version chain.
    const result = await env.DB.batch([
      statement,
      env.DB.prepare(`UPDATE agent_runs SET task_edit_at=?
        WHERE id=? AND agent_id=? AND task_id=? AND status='running'
        AND (task_edit_at=? OR (task_edit_at IS NULL AND created_at>=?))
        AND EXISTS (SELECT 1 FROM tasks WHERE id=? AND updated_at=?)`)
        .bind(updatedAt, authorization.credential.id, actorId, id, task.updatedAt, task.updatedAt, id, updatedAt),
    ])
    changed = result[0]?.meta.changes
  } else {
    changed = (await statement.run()).meta.changes
  }
  if (!changed) fail(409, 'stale_task', 'This task changed elsewhere. Reload and try again.')
  if (input.boardId && input.boardId !== task.boardId) {
    await db.batch([
      db.delete(taskLabelLinks).where(eq(taskLabelLinks.taskId, id)),
      db.delete(taskDependencies).where(or(eq(taskDependencies.taskId, id), eq(taskDependencies.dependsOnTaskId, id))),
    ])
  }
  if (input.labelIds !== undefined) {
    await db.delete(taskLabelLinks).where(eq(taskLabelLinks.taskId, id))
    const labelIds = [...new Set(input.labelIds)]
    if (labelIds.length) await db.insert(taskLabelLinks).values(labelIds.map(labelId => ({ taskId: id, labelId })))
  }
  if (input.dependencyIds !== undefined) {
    await db.delete(taskDependencies).where(eq(taskDependencies.taskId, id))
    const dependencyIds = [...new Set(input.dependencyIds)]
    if (dependencyIds.length) await db.insert(taskDependencies).values(dependencyIds.map(dependsOnTaskId => ({ taskId: id, dependsOnTaskId, createdAt: updatedAt })))
  }
  await writeAudit(env, {
    serverId: (await getServerId(env.DB)),
    actorId,
    action: input.archived === true ? 'task.archive' : input.archived === false ? 'task.restore' : 'task.update',
    targetType: 'task',
    targetId: id,
    meta: { fields: Object.keys(input), fromBoardId: task.boardId, toBoardId: boardId, fromStatus: task.status, toStatus: status },
    authorization,
  })
  schedule(signalTasksChanged(env, boardId, id))
  if (boardId !== task.boardId) schedule(signalTasksChanged(env, task.boardId, id))
  return (await loadTaskDetail(env, id))!
}
