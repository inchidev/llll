import type { TaskDetailDTO, TaskStatus } from '~~/shared/types'

export type TaskEdit = {
  title: string
  description: string
  priority: TaskDetailDTO['priority']
  dueAt: string
  assigneeId: string | null
  projectId: string | null
  environmentId: string | null
  channelId: string | null
  labelIds: string[]
  dependencyIds: string[]
  boardId: string
  status: TaskStatus
}

export function toDateInput(value: string | null) {
  if (!value) return ''
  const date = new Date(value)
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

/** What the Task form shows for a saved Task. */
export function taskEditFields(task: TaskDetailDTO): TaskEdit {
  return {
    title: task.title,
    description: task.description,
    priority: task.priority,
    dueAt: toDateInput(task.dueAt),
    assigneeId: task.assigneeId,
    projectId: task.projectId ?? null,
    environmentId: task.environmentId ?? null,
    channelId: task.channelId,
    labelIds: task.labels.map(label => label.id),
    dependencyIds: [...task.dependencyIds],
    boardId: task.boardId,
    status: task.status,
  }
}

const same = (a: TaskEdit[keyof TaskEdit], b: TaskEdit[keyof TaskEdit]) => Array.isArray(a) && Array.isArray(b)
  ? a.length === b.length && a.every(id => b.includes(id))
  : a === b

/** The fields of the form that differ from the Task: what a save has to send. */
export function changedTaskFields(edit: TaskEdit, saved: TaskEdit): Partial<TaskEdit> {
  return Object.fromEntries((Object.keys(saved) as Array<keyof TaskEdit>)
    .filter(key => !same(edit[key], saved[key]))
    .map(key => [key, edit[key]]))
}

/** A newer copy of the Task for a form with edits: fields the person left alone follow it, theirs stay. */
export function refreshedTaskEdit(edit: TaskEdit, previous: TaskEdit, next: TaskEdit): TaskEdit {
  return Object.fromEntries((Object.keys(next) as Array<keyof TaskEdit>)
    .map(key => [key, same(edit[key], previous[key]) ? next[key] : edit[key]])) as TaskEdit
}
