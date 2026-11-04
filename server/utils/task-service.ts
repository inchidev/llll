import { repositoryResourceId } from '../../shared/code-environments'
import { requireEnvironmentProject, requireProject } from './project-service'
import { Permission } from '../../shared/permissions'
import { anyProjectPermission, projectPermissionAllowed } from '../../shared/project-access'
import { spaceResourceDenied, spaceSql } from '../../shared/spaces'
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
import { spaceOfResource } from './space-access'
import { loadTaskBoards, loadTaskDetail } from './task-data'
import { firstTaskPosition, nextTaskPosition, requireBoard, requireBoardInBoundary, requireTask, taskIdFromReference, requireTaskPermission, requireTaskSpace, taskPermissionAllowed, validateTaskAssignee, validateTaskChannel, validateTaskDependencies, validateTaskLabels } from './task-policy'

async function validateEnvironment(env: L4Env, auth: AuthorizationContext, id: string | null | undefined, spaceId: string) {
  if (!id) return
  const item = await findCodeEnvironment(env, id)
  if (!item?.enabled || await spaceOfResource(env, 'environment', id) !== spaceId) fail(403, 'code_revoked', 'Repository environment is unavailable')
  await requireEnvironmentProject(env, auth, item.id)
  requireResource(auth, 'repositories', repositoryResourceId(item))
}

/** A task in a project with one connected repository works on it unless it names none or another. */
async function soleProjectEnvironment(env: L4Env, auth: AuthorizationContext, projectId: string, spaceId: string) {
  const rows = await env.DB.prepare('SELECT environment_id AS id FROM project_repositories WHERE project_id=? AND environment_id IS NOT NULL LIMIT 2').bind(projectId).all<{ id: string }>()
  const id = rows.results.length === 1 ? rows.results[0]!.id : null
  if (!id) return null
  try { await validateEnvironment(env, auth, id, spaceId); return id } catch { return null }
}

/**
 * A Task can name a Project for agent work, whichever board it sits on. With none, it follows Server Role.
 */
async function taskProject(env: L4Env, auth: AuthorizationContext, requested: string | null | undefined, environmentId: string | null | undefined) {
  // A configuration in another Space has no link, just like a missing one.
  const link = environmentId && !spaceResourceDenied(auth, 'environments', environmentId) ? await env.DB.prepare('SELECT project_id AS projectId FROM project_repositories WHERE environment_id=?').bind(environmentId).first<{ projectId: string }>() : null
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
  coverAttachmentId?: string | null
  labelIds?: string[]
  dependencyIds?: string[]
}

export async function listTasks(
  env: L4Env,
  authorization: AuthorizationContext,
  includeArchived = false,
): Promise<TaskBoardDTO[]> {
  if (!anyProjectPermission(authorization, Permission.readTasks)) authorize(authorization, ServerAction.readTasks)
  const boards = await loadTaskBoards(env, includeArchived, spaceSql(authorization))
  const visible = new Set(boards.flatMap(board => board.tasks).filter(task => taskPermissionAllowed(authorization, task, Permission.readTasks)).map(task => task.id))
  return boards.map(board => ({ ...board, tasks: board.tasks.filter(task => visible.has(task.id)).map(task => ({ ...task, dependencyIds: task.dependencyIds.filter(id => visible.has(id)) })) }))
    .filter(board => board.tasks.length || taskPermissionAllowed(authorization, { boardId: board.id }, Permission.readTasks))
}

export type FindTasksFilter = { names?: Set<string>; status?: TaskStatus; hasRecording?: boolean; limit: number }

/**
 * The newest Tasks you can read across boards, for "the newest bug" rather than whole boards. Names match a
 * Project or one of its repositories, as an agent gives them from its folder. A folder no Project goes by
 * filters nothing and says so. Without a status, finished Tasks are left out.
 */
export async function findTasks(env: L4Env, authorization: AuthorizationContext, filter: FindTasksFilter) {
  const boards = await listTasks(env, authorization)
  let projectIds: Set<string> | null = null
  let note: string | undefined
  if (filter.names?.size) {
    const key = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '')
    const [projects, repositories] = await Promise.all([
      env.DB.prepare(`SELECT id, name FROM projects WHERE space_id IN (${spaceSql(authorization)})`).all<{ id: string; name: string }>(),
      env.DB.prepare(`SELECT r.project_id AS projectId, r.slug FROM project_repositories r JOIN projects p ON p.id = r.project_id WHERE p.space_id IN (${spaceSql(authorization)})`).all<{ projectId: string; slug: string }>(),
    ])
    const matching = [
      ...(projects.results ?? []).filter(project => filter.names!.has(key(project.name))).map(project => project.id),
      ...(repositories.results ?? []).filter(repository => filter.names!.has(key(repository.slug.split('/').at(-1) ?? ''))).map(repository => repository.projectId),
    ].filter(id => projectPermissionAllowed(authorization, id, Permission.readProjects))
    if (matching.length) projectIds = new Set(matching)
    else note = `No Project goes by ${[...filter.names].join(', ')}, so this is every Project's Tasks.`
  }
  const tasks = boards.flatMap(board => board.tasks)
    .filter(task => !projectIds || (task.projectId && projectIds.has(task.projectId)))
    .filter(task => filter.status ? task.status === filter.status : task.status !== 'done' && task.status !== 'failed')
    .filter(task => filter.hasRecording === undefined || task.hasRecording === filter.hasRecording)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.number - a.number)
    .slice(0, filter.limit)
  return { tasks: tasks.map(task => ({ id: task.id, number: task.number, title: task.title, description: task.description.slice(0, 2000), status: task.status, priority: task.priority, boardId: task.boardId, projectId: task.projectId ?? null, assigneeId: task.assigneeId, hasRecording: task.hasRecording, attachmentCount: task.attachmentCount, createdAt: task.createdAt })), ...(note ? { note } : {}) }
}

export async function getTask(
  env: L4Env,
  authorization: AuthorizationContext,
  taskReference: string | number,
): Promise<TaskDetailDTO | null> {
  const task = await loadTaskDetail(env, await taskIdFromReference(env, taskReference, authorization) ?? taskReference)
  if (task && spaceResourceDenied(authorization, 'boards', task.boardId)) return null
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
  const id = await insertTask(env, authorization, boardId, input, schedule)
  return filterTaskDependencies(env, authorization, (await loadTaskDetail(env, id))!)
}

/** Creates the Task and answers only its ID, for a caller that doesn't show it. */
export async function insertTask(
  env: L4Env,
  authorization: AuthorizationContext,
  boardId: string,
  input: CreateTaskInput,
  schedule: Schedule,
): Promise<string> {
  const actorId = authorization.principal.id
  const db = getDb(env.DB)
  const projectId = await taskProject(env, authorization, input.projectId, input.environmentId)
  // Without the boundary here: the next line makes a board in another Space answer as missing.
  requireTaskPermission(authorization, { projectId, boardId }, Permission.writeTasks)
  const board = await requireBoardInBoundary(env, authorization, boardId)
  await requireTaskSpace(env, boardId, projectId)
  if (input.source && await spaceOfResource(env, 'channel', input.source.channelId) !== board.spaceId) fail(400, 'bad_request', 'A Task and its source message must be in the same Space')
  const environmentId = input.environmentId !== undefined ? input.environmentId : projectId ? await soleProjectEnvironment(env, authorization, projectId, board.spaceId) : null
  for (const dependency of input.dependencyIds) await requireTask(env, dependency, authorization)
  await Promise.all([
    validateTaskAssignee(env, input.assigneeId, board.spaceId),
    validateTaskChannel(env, input.channelId, board.spaceId),
    validateEnvironment(env, authorization, input.environmentId, board.spaceId),
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
    // New work is what to look at first, whoever or whatever made it.
    position: await firstTaskPosition(env, boardId, status),
    assigneeId: input.assigneeId,
    channelId: input.channelId,
    environmentId,
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
  const inserts = [
    db.insert(tasks).values(task),
    ...[...new Set(input.labelIds)].map(labelId => db.insert(taskLabelLinks).values({ taskId: id, labelId })),
    ...[...new Set(input.dependencyIds)].map(dependsOnTaskId => db.insert(taskDependencies).values({ taskId: id, dependsOnTaskId, createdAt: now })),
  ]
  await db.batch(inserts as unknown as Parameters<typeof db.batch>[0])
  await writeAudit(env, { serverId: (await getServerId(env.DB)), actorId, action: 'task.create', targetType: 'task', targetId: id, meta: { boardId, assigneeId: input.assigneeId, ...(input.source ? { sourceChannelId: input.source.channelId, sourceMessageId: input.source.messageId } : {}) }, authorization })
  schedule(signalTasksChanged(env, boardId, id))
  return id
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
  // Without the boundary here: the next line makes a board in another Space answer as missing.
  requireTaskPermission(authorization, { projectId, boardId }, Permission.writeTasks)
  const board = await requireBoardInBoundary(env, authorization, boardId)
  if (boardId !== task.boardId && board.spaceId !== (await requireBoard(env, task.boardId)).spaceId) fail(400, 'bad_request', 'A Task cannot move to another Space')
  await requireTaskSpace(env, boardId, projectId)
  for (const dependency of input.dependencyIds ?? []) await requireTask(env, dependency, authorization)
  await Promise.all([
    validateTaskAssignee(env, input.assigneeId, board.spaceId),
    validateTaskChannel(env, input.channelId, board.spaceId),
    validateEnvironment(env, authorization, input.environmentId, board.spaceId),
    validateTaskLabels(env, boardId, input.labelIds),
    validateTaskDependencies(env, id, boardId, input.dependencyIds),
  ])

  if (input.coverAttachmentId) {
    const cover = await env.DB.prepare("SELECT 1 AS ok FROM task_attachments WHERE id=? AND task_id=? AND content_type LIKE 'image/%'").bind(input.coverAttachmentId, id).first()
    if (!cover) fail(400, 'bad_request', 'A cover is an image attached to this Task')
  }

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
    coverAttachmentId: input.coverAttachmentId === undefined ? task.coverAttachmentId : input.coverAttachmentId,
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
