import { expect, it } from 'vitest'
import { changedTaskFields, refreshedTaskEdit, type TaskEdit } from '../../app/utils/task-edit'

const saved: TaskEdit = { title: 'A', description: '', priority: 'normal', dueAt: '', assigneeId: null, projectId: null, environmentId: null, channelId: null, labelIds: ['x', 'y'], dependencyIds: [], boardId: 'board', status: 'ready' }

it('sends nothing but the changed fields, and treats reordered IDs as unchanged', () => {
  expect(changedTaskFields({ ...saved, title: 'B', labelIds: ['y', 'x'] }, saved)).toEqual({ title: 'B' })
  expect(changedTaskFields(saved, saved)).toEqual({})
})

it('takes a refresh for untouched fields and keeps the edited ones', () => {
  const edit = { ...saved, title: 'Mine' }
  const next = { ...saved, title: 'Theirs', status: 'done' as const, labelIds: ['z'] }
  expect(refreshedTaskEdit(edit, saved, next)).toEqual({ ...saved, title: 'Mine', status: 'done', labelIds: ['z'] })
})
