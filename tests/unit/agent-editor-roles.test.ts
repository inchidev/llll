// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { computed, reactive, ref, shallowRef, watch } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import AgentEditor from '../../app/components/settings/AgentEditorModal.vue'
import { TaskAgentPermissions } from '../../shared/agent-roles'
import { ALL_PERMISSIONS, MemberPermissions, rolePermissions } from '../../shared/permissions'

afterEach(() => vi.unstubAllGlobals())
const admin = { id: 'admin-role', key: 'admin', name: 'Admin', permissions: rolePermissions('admin'), resourceAccess: {} }
const taskRole = { id: 'task-role', key: 'custom:task', name: 'Task agent', permissions: TaskAgentPermissions, resourceAccess: { boards: ['allowed'] } }
const agent = { id: 'fixture-agent', roleId: admin.id, displayName: 'Helper', avatarR2Key: null, model: 'fixture-model', instructions: '', status: 'active' as const, lastActiveAt: null, createdAt: '', updatedAt: '' }

async function editor(editing = true, existingTaskRole = true) {
  const savedRoles = [{ id: 'member-role', key: 'member', name: 'Member', permissions: MemberPermissions, resourceAccess: {} }, admin, ...(existingTaskRole ? [taskRole] : [])]
  const api = vi.fn(async (path: string, opts?: { method?: string; body?: Record<string, unknown> }) => {
    if (path.endsWith('/roles')) {
      if (opts?.method === 'POST') { savedRoles.push(taskRole); return { role: taskRole } }
      return { roles: [...savedRoles] }
    }
    if (opts?.method === 'PATCH' || opts?.method === 'POST') return { agent: { ...agent, roleId: taskRole.id, ...opts.body } }
    return { models: [{ value: 'fixture-model', label: 'Fixture', provider: 'OpenRouter' }], defaultModel: 'fixture-model' }
  })
  const mine = ref({ role: { permissions: ALL_PERMISSIONS, resourceAccess: { boards: ['allowed'] } } })
  for (const [name, value] of Object.entries({ computed, reactive, ref, shallowRef, watch, useApi: () => ({ api }), useToast: () => ({ add: vi.fn() }), useSessionStore: () => ({ health: null }), useRoleGrants: () => ({ can: () => true, mine }), errorMessage: String })) vi.stubGlobal(name, value)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const select = { props: ['items', 'modelValue', 'disabled'], emits: ['update:modelValue'], template: '<select :value="modelValue" :disabled="disabled" @change="$emit(\'update:modelValue\', $event.target.value)"><option v-for="item in items" :value="item.value">{{ item.label }}</option></select>' }
  const view = mount(AgentEditor, { props: { serverId: 'fixture-server', open: true, agent: editing ? agent : null }, global: { plugins: [[VueQueryPlugin, { queryClient: client }]], stubs: {
    UModal: { template: '<div><slot name="body" /></div>' },
    UForm: { props: ['state'], emits: ['submit'], template: '<form @submit.prevent="$emit(\'submit\', { data: state })"><slot /></form>' },
    UFormField: { props: ['label'], template: '<label>{{ label }}<slot /></label>' },
    USelect: select, USelectMenu: select,
    UInput: { props: ['modelValue'], emits: ['update:modelValue'], template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />' },
    UButton: { props: ['label', 'disabled', 'type'], template: '<button :type="type || \'button\'" :disabled="disabled">{{ label }}</button>' },
    UAlert: true, UFileUpload: true, UTextarea: true, UserAvatar: true, LayoutLoadError: true,
  } } })
  await flushPromises()
  return { view, api, close: () => { view.unmount(); client.clear() } }
}
it('shows the current role and missing task grant when editing an Admin agent, then saves its replacement', async () => {
  const { view, api, close } = await editor()
  try {
    expect((view.get('[aria-label="Agent role"]').element as HTMLSelectElement).value).toBe(admin.id)
    expect(view.text()).toContain('Assigned tasks need: Execute assigned tasks.')
    await view.get('[aria-label="Agent role"]').setValue(taskRole.id)
    expect(view.text()).toContain('Can execute assigned tasks')
    await view.get('form').trigger('submit'); await flushPromises()
    expect(api).toHaveBeenCalledWith('/api/servers/fixture-server/agents/fixture-agent', expect.objectContaining({ method: 'PATCH', body: expect.objectContaining({ roleId: taskRole.id }) }))
  } finally { close() }
})
it('does not send an unchanged role with a profile-only save', async () => {
  const { view, api, close } = await editor()
  try {
    await view.get('input').setValue('Renamed')
    await view.get('form').trigger('submit'); await flushPromises()
    const call = api.mock.calls.find(([, opts]) => opts?.method === 'PATCH')
    expect(call?.[1]?.body).not.toHaveProperty('roleId')
  } finally { close() }
})
it('creates a new agent with the default role without creating a role implicitly', async () => {
  const { view, api, close } = await editor(false, false)
  try {
    expect(api.mock.calls.some(([, opts]) => opts?.method === 'POST')).toBe(false)
    await view.get('input').setValue('Helper')
    await view.get('form').trigger('submit'); await flushPromises()
    expect(api.mock.calls.some(([path, opts]) => path.endsWith('/roles') && opts?.method === 'POST')).toBe(false)
    expect(api).toHaveBeenCalledWith('/api/servers/fixture-server/agents', expect.objectContaining({ method: 'POST', body: expect.objectContaining({ roleId: undefined }) }))
  } finally { close() }
})
it('lets a new agent use an existing role without changing its policies', async () => {
  const { view, api, close } = await editor()
  try {
    await view.get('[aria-label="Agent role"]').setValue(taskRole.id)
    expect(api.mock.calls.some(([path, opts]) => path.endsWith('/roles') && opts?.method === 'POST')).toBe(false)
    expect((view.get('[aria-label="Agent role"]').element as HTMLSelectElement).value).toBe(taskRole.id)
  } finally { close() }
})

it('uses the actual Member role ID when moving an existing agent back to Member', async () => {
  const { view, api, close } = await editor()
  try {
    await view.get('[aria-label="Agent role"]').setValue('member-role')
    await view.get('form').trigger('submit'); await flushPromises()
    expect(api).toHaveBeenCalledWith('/api/servers/fixture-server/agents/fixture-agent', expect.objectContaining({ method: 'PATCH', body: expect.objectContaining({ roleId: 'member-role' }) }))
  } finally { close() }
})
