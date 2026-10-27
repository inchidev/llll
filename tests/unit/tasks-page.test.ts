// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computed, defineComponent, h, reactive, ref, shallowRef, useTemplateRef, watch } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import Tasks from '../../app/pages/tasks.vue'
let client: QueryClient, api: ReturnType<typeof vi.fn>
const templateTask = { id: 'task', number: 1001, title: 'Say OK', description: '', status: 'ready', boardId: 'board', priority: 'normal', dueAt: null, assigneeId: 'agent', channelId: 'general' as string | null, discussionChannelId: null as string | null, labels: [], dependencyIds: [], checklist: [], attachments: [], createdAt: '', updatedAt: '', archivedAt: null as string | null }
let task = { ...templateTask }, agentStatus = 'active'
const Button = defineComponent({ props: ['label', 'disabled', 'loading'], setup: (p, { attrs }) => () => h('button', { ...attrs, disabled: p.disabled || p.loading }, p.label) })
const Input = defineComponent({ props: ['modelValue'], emits: ['update:modelValue'], setup: (p, { emit }) => () => h('input', { value: p.modelValue, onInput: (e: Event) => emit('update:modelValue', (e.target as HTMLInputElement).value) }) })
const Select = defineComponent({ props: ['modelValue', 'items'], emits: ['update:modelValue'], setup: (p, { emit }) => () => h('select', { value: p.modelValue ?? '', onChange: (e: Event) => emit('update:modelValue', (e.target as HTMLSelectElement).value || null) }, p.items.filter((i: {type?: string}) => !i.type).map((i: {value: string; label: string}) => h('option', { value: i.value ?? '' }, i.label))) })
const Modal = defineComponent({ props: ['open', 'title'], setup: (p, { slots }) => () => p.open ? h('section', [h('h2', p.title), slots.body?.(), slots.footer?.()]) : null })
let view: ReturnType<typeof mount>
beforeEach(() => {
  task = { ...templateTask }; agentStatus = 'active'

  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  api = vi.fn(async (url: string) => {
    if (url === '/api/agent-runs') return { run: { id: 'fixture-run' } }
    if (url === '/api/boards/board/tasks') return { task: { ...task, id: 'created-task' } }
    if (url.endsWith('/boards')) return { boards: [{ id: 'board', name: 'Work', tasks: [task], labels: [], archivedAt: null }] }
    if (url.endsWith('/discussion')) return { channelId: 'task-discussion' }
    if (url.startsWith('/api/tasks/')) return { task }
    if (url.endsWith('/members')) return { members: [{ user: { id: 'agent', kind: 'agent', displayName: 'Pi' }, role: { permissions: 0x7fffffff } }] }
    if (url.endsWith('/task-agents')) return { agents: [{ id: 'agent', displayName: 'Pi', status: agentStatus }] }
    if (url.endsWith('/channels')) return { channels: [{ id: 'general', name: 'general', type: 'text', visibility: 'server' }] }
    return { environments: [] }
  })
  for (const [name, value] of Object.entries({ computed, reactive, ref, shallowRef, useTemplateRef, watch, definePageMeta: vi.fn(), useServer: () => ({ serverId: ref('server') }), useRoleGrants: () => ({ can: () => true, canAnyProject: () => true }), useIsMobile: () => ref(false), useApi: () => ({ api }), useToast: () => ({ add: vi.fn() }), useRoute: () => ({ query: { board: 'board', task: '1001' } }), useNavActions: () => ({ createBoardOpen: ref(false) }), useSessionStore: () => ({ health: { bindings: {} } }), navigateTo: vi.fn(), errorMessage: String })) vi.stubGlobal(name, value)
})
afterEach(() => { view?.unmount(); client.clear(); vi.unstubAllGlobals() })
async function render() {
  view = mount(Tasks, { global: { mocks: { useSessionStore: () => ({ health: { bindings: {} } }) }, plugins: [[VueQueryPlugin, { queryClient: client }]], stubs: { UButton: Button, UModal: Modal, USlideover: Modal, UFormField: { props: ['label'], template: '<label>{{ label }}<slot /></label>' }, USelect: Select, UInput: Input, UTextarea: true, UCheckbox: true, UBadge: true, UserAvatar: true, UIcon: true, UDropdownMenu: { template: '<div><slot /></div>' }, TasksDiscussion: true, LayoutSaveBar: true, LayoutSkeleton: true, LayoutLoadError: true, LayoutPageHeader: { template: '<header><slot name="actions" /></header>' }, LayoutEmptyState: true, UAlert: true, ULink: true } } })
  await flushPromises(); await flushPromises()
}
it('explains that agent assignment waits for an explicit start rather than looking queued', async () => {
  await render()
  expect(view.text()).toContain('Assignment does not start a run')
  expect(view.findAll('button').some(b => b.text() === 'Run assigned agent')).toBe(true)
})

it('creates and starts an assigned task only through the explicit Create and run action', async () => {
  await render()
  await view.get('[aria-label="New task"]').trigger('click')
  const modal = view.findAll('section').find(s => s.find('h2').exists() && s.find('h2').text() === 'Create task')!
  await modal.get('input').setValue('New work')
  await modal.findAll('label').find(l => l.text().startsWith('Assignee'))!.get('select').setValue('agent')
  await modal.findAll('label').find(l => l.text().startsWith('Report channel'))!.get('select').setValue('general')
  expect(api.mock.calls.some(([url]) => url === '/api/agent-runs')).toBe(false)
  await modal.findAll('button').find(b => b.text() === 'Create and run')!.trigger('click')
  await flushPromises()
  expect(api).toHaveBeenCalledWith('/api/agent-runs', expect.objectContaining({ body: expect.objectContaining({ taskId: 'created-task', agentId: 'agent', channelId: 'general' }) }))
  expect(navigateTo).toHaveBeenCalledWith('/runs/fixture-run')
})

it.each([false, true])('runs without a report channel using the task discussion (already exists: %s)', async exists => {
  task.channelId = null; task.discussionChannelId = exists ? 'existing-discussion' : null
  await render()
  const button = view.findAll('button').find(item => item.text() === 'Run assigned agent')!
  expect(button.attributes('disabled')).toBeUndefined()
  expect(view.text()).toContain('A separate report channel is optional')
  await button.trigger('click'); await flushPromises()
  expect(api).toHaveBeenCalledWith('/api/agent-runs', expect.objectContaining({ body: expect.objectContaining({ channelId: exists ? 'existing-discussion' : 'task-discussion' }) }))
  expect(api.mock.calls.filter(([url]) => url.endsWith('/discussion'))).toHaveLength(exists ? 0 : 1)
  expect(api.mock.calls.some(([url, options]) => url === '/api/tasks/task' && options?.method === 'PATCH')).toBe(false)
})
it('explains a paused agent beside the disabled action at the top of the dialog', async () => {
  agentStatus = 'paused'; await render()
  const section = view.get('[aria-label="Agent task execution"]')
  expect(section.text()).toContain('Resume the assigned agent')
  expect(section.get('button').attributes('disabled')).toBeDefined()
  expect(section.get('button').attributes('aria-describedby')).toBe('task-run-problem')
  expect(view.html().indexOf('Agent task execution')).toBeLessThan(view.html().indexOf('<fieldset'))
})
it('does not launch if creating the default discussion fails', async () => {
  task.channelId = null
  const original = api.getMockImplementation()!
  api.mockImplementation(async (url: string) => { if (url.endsWith('/discussion')) throw Error('Discussion denied'); return original(url) })
  await render(); await view.findAll('button').find(item => item.text() === 'Run assigned agent')!.trigger('click'); await flushPromises()
  expect(api.mock.calls.some(([url]) => url === '/api/agent-runs')).toBe(false)
})
it('allows Create and run without selecting a separate report channel', async () => {
  task.channelId = null
  await render(); await view.get('[aria-label="New task"]').trigger('click')
  const modal = view.findAll('section').find(s => s.find('h2').exists() && s.find('h2').text() === 'Create task')!
  await modal.get('input').setValue('Work in task discussion')
  await modal.findAll('label').find(l => l.text().startsWith('Assignee'))!.get('select').setValue('agent')
  await modal.findAll('button').find(item => item.text() === 'Create and run')!.trigger('click'); await flushPromises()
  expect(api).toHaveBeenCalledWith('/api/tasks/created-task/discussion', { method: 'POST' })
  expect(api).toHaveBeenCalledWith('/api/agent-runs', expect.objectContaining({ body: expect.objectContaining({ taskId: 'created-task', channelId: 'task-discussion' }) }))
})
it('requires unsaved task edits to be saved before starting the persisted assignment', async () => {
  await render(); await view.get('fieldset input').setValue('Unsaved title')
  const section = view.get('[aria-label="Agent task execution"]')
  expect(section.text()).toContain('Save your task changes')
  expect(section.get('button').attributes('disabled')).toBeDefined()
  expect(api.mock.calls.some(([url]) => url === '/api/agent-runs')).toBe(false)
})
it('explains why an archived task cannot start an agent', async () => {
  task.archivedAt = '2026-10-24'
  await render()
  const section = view.get('[aria-label="Agent task execution"]')
  expect(section.text()).toContain('Restore this task')
  expect(section.get('button').attributes('disabled')).toBeDefined()
})
