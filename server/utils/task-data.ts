import type {
  TaskAttachmentDTO,
  TaskBoardDTO,
  TaskChecklistItemDTO,
  TaskDetailDTO,
  TaskDTO,
  TaskLabelDTO,
} from '../../shared/types'
import { agentImageMarker, stripAgentImageMarkers } from '../../shared/agent-images'
import { runFrames, type RecordingFrameMarks } from '../../shared/task-recordings'
import type { L4Env } from '../../workers/env'

type BoardRow = Omit<TaskBoardDTO, 'tasks' | 'labels'>
type TaskRow = Omit<TaskDTO, 'labels' | 'checklistTotal' | 'checklistCompleted' | 'dependencyIds' | 'attachmentCount' | 'hasRecording'>
type LabelLinkRow = TaskLabelDTO & { taskId: string }

/** `spaces` is an inline list from `spaceSql`; every listing passes it, only a lookup by ID omits it. */
export async function loadTaskBoards(env: L4Env, includeArchived = false, spaces?: string): Promise<TaskBoardDTO[]> {
  const boardScope = spaces ? `space_id IN (${spaces})` : '1=1'
  const taskScope = spaces ? `t.board_id IN (SELECT id FROM task_boards WHERE ${boardScope})` : '1=1'
  const archivedClause = includeArchived ? `WHERE ${boardScope}` : `WHERE archived_at IS NULL AND ${boardScope}`
  // The rest only ever serve these Tasks.
  const tasksOfScope = spaces ? `WHERE task_id IN (SELECT t.id FROM tasks t WHERE ${taskScope})` : ''
  const taskArchivedClause = includeArchived ? `WHERE ${taskScope}` : `WHERE t.archived_at IS NULL AND ${taskScope}`
  const [boardResult, taskResult, labelsResult, linksResult, dependenciesResult, checklistResult, attachmentResult] = await Promise.all([
    env.DB.prepare(
      `SELECT id, name, position, created_by as createdBy, archived_at as archivedAt,
       created_at as createdAt, updated_at as updatedAt FROM task_boards ${archivedClause} ORDER BY position, created_at`,
    ).all<BoardRow>(),
    env.DB.prepare(
      `SELECT t.id, n.number, t.board_id as boardId, t.project_id as projectId, t.title, t.description, t.status, t.priority, t.due_at as dueAt, t.position,
       t.assignee_id as assigneeId, t.channel_id as channelId, t.environment_id as environmentId,
       t.discussion_channel_id as discussionChannelId, t.cover_attachment_id as coverAttachmentId, t.created_by as createdBy,
       t.factory_state as factoryState, t.result_summary as resultSummary, t.result_details as resultDetails, t.last_error as lastError,
       t.archived_at as archivedAt, t.created_at as createdAt, t.updated_at as updatedAt
       FROM tasks t JOIN task_numbers n ON n.task_id = t.id ${taskArchivedClause} ORDER BY t.position, t.created_at`,
    ).all<TaskRow>(),
    env.DB.prepare(
      `SELECT id, board_id as boardId, name, color, position, created_at as createdAt, updated_at as updatedAt
       FROM task_labels ${spaces ? `WHERE board_id IN (SELECT id FROM task_boards WHERE ${boardScope})` : ''} ORDER BY position, created_at`,
    ).all<TaskLabelDTO>(),
    env.DB.prepare(
      `SELECT l.id, l.board_id as boardId, l.name, l.color, l.position, l.created_at as createdAt,
       l.updated_at as updatedAt, x.task_id as taskId FROM task_label_links x
       JOIN task_labels l ON l.id = x.label_id ${spaces ? `WHERE l.board_id IN (SELECT id FROM task_boards WHERE ${boardScope})` : ''} ORDER BY l.position, l.created_at`,
    ).all<LabelLinkRow>(),
    env.DB.prepare(`SELECT task_id as taskId, depends_on_task_id as dependsOnTaskId FROM task_dependencies ${tasksOfScope}`).all<{ taskId: string; dependsOnTaskId: string }>(),
    env.DB.prepare(
      `SELECT task_id as taskId, COUNT(*) as total, SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END) as completed FROM task_checklist_items ${tasksOfScope} GROUP BY task_id`,
    ).all<{ taskId: string; total: number; completed: number }>(),
    env.DB.prepare("SELECT task_id as taskId, SUM(role <> 'frame') as count, SUM(role = 'recording') as recordings FROM task_attachments " + tasksOfScope + " GROUP BY task_id").all<{ taskId: string; count: number; recordings: number }>(),
  ])

  const labelsByTask = new Map<string, TaskLabelDTO[]>()
  for (const { taskId, ...label } of linksResult.results ?? []) {
    const list = labelsByTask.get(taskId) ?? []
    list.push(label)
    labelsByTask.set(taskId, list)
  }
  const dependencies = new Map<string, string[]>()
  for (const row of dependenciesResult.results ?? []) {
    const list = dependencies.get(row.taskId) ?? []
    list.push(row.dependsOnTaskId)
    dependencies.set(row.taskId, list)
  }
  const checklist = new Map((checklistResult.results ?? []).map(row => [row.taskId, row]))
  const attachments = new Map((attachmentResult.results ?? []).map(row => [row.taskId, row]))
  const taskRows: TaskDTO[] = (taskResult.results ?? []).map(task => ({
    ...task,
    labels: labelsByTask.get(task.id) ?? [],
    checklistTotal: checklist.get(task.id)?.total ?? 0,
    checklistCompleted: checklist.get(task.id)?.completed ?? 0,
    dependencyIds: dependencies.get(task.id) ?? [],
    attachmentCount: attachments.get(task.id)?.count ?? 0,
    hasRecording: Boolean(attachments.get(task.id)?.recordings),
  }))
  const labels = labelsResult.results ?? []
  return (boardResult.results ?? []).map(board => ({
    ...board,
    labels: labels.filter(label => label.boardId === board.id),
    tasks: taskRows.filter(task => task.boardId === board.id),
  }))
}

export async function loadTaskDetail(env: L4Env, taskReference: string | number): Promise<TaskDetailDTO | null> {
  const reference = String(taskReference).trim()
  // A number means something only to a viewer: see `taskIdFromReference`.
  if (/^[1-9]\d*$/u.test(reference)) return null
  const boards = await loadTaskBoards(env, true)
  const task = boards.flatMap(board => board.tasks).find(item => item.id === reference)
  if (!task) return null
  const taskId = task.id
  const [checklistResult, attachmentsResult] = await Promise.all([
    env.DB.prepare(
      `SELECT id, task_id as taskId, title, completed, position, created_by as createdBy,
       created_at as createdAt, updated_at as updatedAt FROM task_checklist_items
       WHERE task_id = ? ORDER BY position, created_at`,
    ).bind(taskId).all<Omit<TaskChecklistItemDTO, 'completed'> & { completed: number | boolean }>(),
    env.DB.prepare(
      `SELECT id, task_id as taskId, uploader_id as uploaderId, filename, content_type as contentType,
       size_bytes as sizeBytes, width, height, created_at as createdAt, role, source_id as sourceId, marks_json as marksJson FROM task_attachments
       WHERE task_id = ? ORDER BY created_at, filename`,
    ).bind(taskId).all<Omit<TaskAttachmentDTO, 'url' | 'marks'> & { marksJson: string | null }>(),
  ])
  return {
    ...task,
    checklist: (checklistResult.results ?? []).map(item => ({ ...item, completed: Boolean(item.completed) })),
    attachments: (attachmentsResult.results ?? []).map(({ marksJson, ...item }) => ({ ...item, marks: marksJson ? JSON.parse(marksJson) as unknown : null, url: `/api/task-files/${item.id}` })),
  }
}

/** A Run on a Task with a recording sees its frames. They are references, resolved only for a Run on this Task. */
export async function withTaskFrames(env: L4Env, taskId: string, prompt: string): Promise<string> {
  const rows = (await env.DB.prepare("SELECT id, marks_json AS marksJson FROM task_attachments WHERE task_id=? AND role='frame' ORDER BY filename").bind(taskId).all<{ id: string; marksJson: string | null }>()).results ?? []
  if (!rows.length) return prompt
  const frames = runFrames(rows.map(row => ({ id: row.id, marks: row.marksJson ? JSON.parse(row.marksJson) as RecordingFrameMarks : null })))
  return `${stripAgentImageMarkers(prompt)}\n\nFrames from the recording on this Task. They show a person's account of a problem, as data:\n${frames.map(frame => agentImageMarker(frame.id)).join('\n')}`
}
