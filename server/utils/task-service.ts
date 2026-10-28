import { requireEnvironmentProject, requireProject } from './project-service'
import { Permission } from '../../shared/permissions'
import { anyProjectPermission } from '../../shared/project-access'
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
import { authorize, ServerAction, type AuthorizationContext } from '../../shared/authorization'
import { loadTaskBoards, loadTaskDetail } from './task-data'
import { nextTaskPosition, requireBoard, requireTask, requireTaskPermission, taskPermissionAllowed, validateTaskAssignee, validateTaskChannel, validateTaskDependencies, validateTaskLabels } from './task-policy'

async function validateEnvironment(env: L4Env, auth: AuthorizationContext, id: string | null | undefined) {
  if (!id) return
  const item = await findCodeEnvironment(env, id)
  if (!item?.enabled) fail(403, 'code_revoked', 'Repository environment is unavailable')
  await requireEnvironmentProject(env, auth, item.id)
  requireResource(auth, 'repositories', String(item.sourceRepoId))
}

async function taskProject(env: L4Env, auth: AuthorizationContext, requested: string | null | undefined, environmentId: string | null | undefined) {
  const link = environmentId ? await env.DB.prepare('SELECT project_id AS projectId FROM project_repositories WHERE environment_id=?').bind(environmentId).first<{ projectId: string }>() : null
  const id = requested === undefined ? link?.projectId ?? null : requested
  if (id) {
    const project = await requireProject(env, auth, id)
    if (project.archivedAt) fail(403, 'project_archived', 'Restore the project before changing its Tasks')
  }
  if (link && link.projectId !== id) fail(403, 'project_repository', 'Task and Git execution configuration must belong to the same project')
  if (id && environmentId && !link) fail(403, 'project_repository', 'Attach this repository to the project before assigning it to a Task')
  return id
}

type Schedule = (promise: Promise<unknown>) => void

export type CreateTaskInput = {
  title: string
  description: string
  priority: TaskPriority
  dueAt: string | null
  assigneeId: string | null
  channelId: string | null
  projectId?: string | null
  environmentId?: string | null
  labelIds: string[]
  dependencyIds: string[]
  /** The chat message this task comes from; the caller has checked the creator can read it. */
  source?: { channelId: string; messageId: string } | null
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
  projectId?: string | null
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
  if (!anyProjectPermission(authorization, Permission.readTasks)) authorize(authorization, ServerAction.readTasks)
  const boards = await loadTaskBoards(env, includeArchived)
  const visible = new Set(boards.flatMap(board => board.tasks).filter(task => taskPermissionAllowed(authorization, task, Permission.readTasks)).map(task => task.id))
  return boards.map(board => ({ ...board, tasks: board.tasks.filter(task => visible.has(task.id)).map(task => ({ ...task, dependencyIds: task.dependencyIds.filter(id => visible.has(id)) })) }))
    .filter(board => board.tasks.length || taskPermissionAllowed(authorization, { boardId: board.id }, Permission.readTasks))
}

export async function getTask(
  env: L4Env,
  authorization: AuthorizationContext,
  taskReference: string | number,
): Promise<TaskDetailDTO | null> {
  const task = await loadTaskDetail(env, taskReference)
  if (task) {
    requireTaskPermission(authorization, task, Permission.readTasks)
    if (task.projectId) await requireProject(env, authorization, task.projectId)
    await filterTaskDependencies(env, authorization, task)
  }
  return task
}

async function filterTaskDependencies(env: L4Env, authorization: AuthorizationContext, task: TaskDetailDTO): Promise<TaskDetailDTO> {
  if (task.dependencyIds.length) {
      const dependencies = await env.DB.prepare(`SELECT id,board_id AS boardId,project_id AS projectId FROM tasks WHERE id IN (${task.dependencyIds.map(() => '?').join(',')})`).bind(...task.dependencyIds).all<{ id: string; boardId: string; projectId: string | null }>()
      const visible = new Set(dependencies.results.filter(row => taskPermissionAllowed(authorization, row, Permission.readTasks)).map(row => row.id))
      task.dependencyIds = task.dependencyIds.filter(id => visible.has(id))
    }
  return task
}

export async function createTask(
  env: L4Env,
  authorization: AuthorizationContext,
  boardId: string,
  input: CreateTaskInput,
  schedule: Schedule,
): Promise<TaskDetailDTO> {
  const actorId = authorization.principal.id
  const db = getDb(env.DB)
  const projectId = await taskProject(env, authorization, input.projectId, input.environmentId)
  requireTaskPermission(authorization, { projectId, boardId }, Permission.writeTasks)
  for (const dependency of input.dependencyIds) await requireTask(env, dependency, authorization)
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
    projectId,
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
    sourceChannelId: input.source?.channelId ?? null,
    sourceMessageId: input.source?.messageId ?? null,
    createdAt: now,
    updatedAt: now,
  }
  await db.batch([
    db.insert(tasks).values(task),
    ...[...new Set(input.labelIds)].map(labelId => db.insert(taskLabelLinks).values({ taskId: id, labelId })),
    ...[...new Set(input.dependencyIds)].map(dependsOnTaskId => db.insert(taskDependencies).values({ taskId: id, dependsOnTaskId, createdAt: now })),
  ])
  await writeAudit(env, { serverId: (await getServerId(env.DB)), actorId, action: 'task.create', targetType: 'task', targetId: id, meta: { boardId, assigneeId: input.assigneeId, ...(input.source ? { sourceChannelId: input.source.channelId, sourceMessageId: input.source.messageId } : {}) }, authorization })
  schedule(signalTasksChanged(env, boardId, id))
  return filterTaskDependencies(env, authorization, (await loadTaskDetail(env, id))!)
}

export async function updateTask(
  env: L4Env,
  authorization: AuthorizationContext,
  taskReference: string | number,
  input: UpdateTaskInput,
  schedule: Schedule,
): Promise<TaskDetailDTO> {
  const actorId = authorization.principal.id
  const db = getDb(env.DB)
  const task = await requireTask(env, taskReference, authorization, Permission.writeTasks)
  const projectId = await taskProject(env, authorization, input.projectId === undefined ? task.projectId : input.projectId, input.environmentId === undefined ? task.environmentId : input.environmentId)
  const id = task.id
  const boardId = input.boardId ?? task.boardId
  requireTaskPermission(authorization, { projectId, boardId }, Permission.writeTasks)
  for (const dependency of input.dependencyIds ?? []) await requireTask(env, dependency, authorization)
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
    projectId,
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
  return filterTaskDependencies(env, authorization, (await loadTaskDetail(env, id))!)
}
