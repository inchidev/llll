// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computed, defineComponent, h, ref, watch } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import Hierarchy from '../../app/components/tasks/Hierarchy.vue'
import type { TaskDetailDTO, TaskDTO } from '../../shared/types'

let client: QueryClient, api: ReturnType<typeof vi.fn>, writable: boolean
const Button = defineComponent({ props: ['label', 'disabled'], setup: (p, { attrs }) => () => h('button', { ...attrs, disabled: p.disabled }, p.label) })
const Select = defineComponent({ props: ['modelValue', 'items', 'disabled'], emits: ['update:modelValue'], setup: (p, { emit }) => () => h('select', { value: p.modelValue ?? '', disabled: p.disabled, onChange: (e: Event) => emit('update:modelValue', (e.target as HTMLSelectElement).value) }, [h('option', { value: '' }, 'Choose'), ...p.items.map((i: { value: string; label: string }) => h('option', { value: i.value }, i.label))]) })
const template: TaskDetailDTO = { id: 'parent', number: 1, boardId: 'board', projectId: null, parentTaskId: null, parent: null, subtasks: [], subtaskTotal: 0, subtaskCompleted: 0, title: 'Ship search', description: '', status: 'backlog', priority: 'normal', dueAt: null, position: 0, assigneeId: null, channelId: null, discussionChannelId: null, coverAttachmentId: null, hasRecording: false, createdBy: 'owner', resultSummary: null, resultDetails: null, lastError: null, archivedAt: null, createdAt: '', updatedAt: '', labels: [], checklistTotal: 0, checklistCompleted: 0, dependencyIds: [], attachmentCount: 0, checklist: [], attachments: [] }
const task = (id: string, extra: Partial<TaskDTO> = {}): TaskDTO => ({ ...template, id, title: id, ...extra })
let view: ReturnType<typeof mount>
beforeEach(() => {
  client = new QueryClient(); api = vi.fn(async () => ({})); writable = true
  for (const [name, value] of Object.entries({ computed, ref, watch, useApi: () => ({ api }), useRoleGrants: () => ({ can: () => writable }), useToast: () => ({ add: vi.fn() }), errorMessage: String })) vi.stubGlobal(name, value)
})
afterEach(() => { view?.unmount(); client.clear(); vi.unstubAllGlobals() })
function render(extra: Partial<TaskDetailDTO> = {}, tasks: TaskDTO[] = [], dirty = false) {
  view = mount(Hierarchy, { props: { task: { ...template, ...extra }, tasks, dirty }, global: { plugins: [[VueQueryPlugin, { queryClient: client }]], stubs: { UButton: Button, USelectMenu: Select, UFormField: { props: ['label'], template: '<label>{{ label }}<slot /></label>' }, ULink: { props: ['to'], template: '<a :href="`/projects/board?task=${to.query.task}`"><slot /></a>' }, UIcon: true, UBadge: true } } })
}
it('creates work and links a top-level task using the saved parent ID', async () => {
  render({}, [task('existing')])
  await view.findAll('button').find(b => b.text() === 'Create subtask')!.trigger('click')
  expect(view.emitted('create')).toHaveLength(1)
  await view.findAll('select')[1]!.setValue('existing')
  await view.findAll('button').find(b => b.text() === 'Link subtask')!.trigger('click'); await flushPromises()
  expect(api).toHaveBeenCalledWith('/api/tasks/existing', { method: 'PATCH', body: { parentTaskId: 'parent' } })
})
it('excludes descendants from parent choices and ancestors from child choices', () => {
  render({ parentTaskId: 'ancestor' }, [task('ancestor'), task('parent', { parentTaskId: 'ancestor' }), task('child', { parentTaskId: 'parent' }), task('grandchild', { parentTaskId: 'child' }), task('peer'), task('other', { projectId: 'other-project' })])
  const selects = view.findAll('select')
  expect(selects[0]!.findAll('option').map(o => o.attributes('value'))).toEqual(['', 'peer'])
  expect(selects[1]!.findAll('option').map(o => o.attributes('value'))).toEqual(['', 'peer'])
})
it('allows read-only navigation to archived parents and children with no mutations', () => {
  writable = false
  render({ parent: task('ancestor', { archivedAt: 'y' }), parentTaskId: 'ancestor', subtasks: [task('child')], subtaskTotal: 1 }, [task('peer')])
  expect(view.findAll('a').map(a => a.attributes('href'))).toEqual(['/projects/board?task=ancestor', '/projects/board?task=child'])
  expect(view.findAll('button')).toHaveLength(0)
  expect(view.get('[aria-label="Subtask completion"]').attributes('max')).toBe('1')
})
it('offers to detach an archived subtask, and an archived task from its parent', async () => {
  render({ subtasks: [task('old', { archivedAt: 'y' })], subtaskTotal: 0 })
  await view.get('[aria-label="Detach #1 old"]').trigger('click'); await flushPromises()
  expect(api).toHaveBeenCalledWith('/api/tasks/old', { method: 'PATCH', body: { parentTaskId: null } })
  render({ archivedAt: 'y', parent: task('ancestor'), parentTaskId: 'ancestor' }, [task('peer')])
  expect(view.find('[aria-label="Detach from parent"]').exists()).toBe(true)
  expect(view.findAll('select')).toHaveLength(0)
})
it('keeps unsaved edits safe by disabling hierarchy mutations until saved', () => {
  render({ parent: task('ancestor'), parentTaskId: 'ancestor', subtasks: [task('child')], subtaskTotal: 1 }, [task('peer')], true)
  expect(view.text()).toContain('Save or reset your edits')
  expect(view.findAll('button').every(b => b.attributes('disabled') !== undefined)).toBe(true)
})
it('detaches a child without deleting it', async () => {
  render({ subtasks: [task('child')] })
  await view.get('[aria-label="Detach #1 child"]').trigger('click'); await flushPromises()
  expect(api).toHaveBeenCalledWith('/api/tasks/child', { method: 'PATCH', body: { parentTaskId: null } })
})
