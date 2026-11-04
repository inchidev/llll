// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { computed, reactive, ref, shallowRef, watch } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import AgentEditor from '../../app/components/settings/AgentEditorModal.vue'

afterEach(() => vi.unstubAllGlobals())
const agent = { id: 'fixture-agent', roleId: 'member-role', displayName: 'Helper', avatarR2Key: null, model: 'fixture-model', instructions: '', status: 'active' as const, lastActiveAt: null, createdAt: '', updatedAt: '' }

async function editor(canManage = true) {
  const api = vi.fn(async (_path: string, opts?: { method?: string }) => {
    if (opts?.method === 'DELETE') return { ok: true, cancelledRuns: 1, unassignedTasks: 2 }
    return { models: [], defaultModel: 'fixture-model', roles: [] }
  })
  const toast = vi.fn()
  for (const [name, value] of Object.entries({ computed, reactive, ref, shallowRef, watch, useApi: () => ({ api }), useToast: () => ({ add: toast }), useSessionStore: () => ({ health: null }), useRoleGrants: () => ({ can: () => canManage, mine: ref(null) }), errorMessage: String })) vi.stubGlobal(name, value)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = mount(AgentEditor, { props: { serverId: 'fixture-server', open: true, agent }, global: { plugins: [[VueQueryPlugin, { queryClient: client }]], stubs: {
    UModal: { props: ['open', 'title'], template: '<section v-if="open" :data-title="title"><slot name="body" /><slot name="footer" /></section>' },
    UForm: { template: '<form><slot /></form>' }, UFormField: { template: '<div><slot /></div>' },
    USelect: true, USelectMenu: true, UInput: true, UAlert: true, UFileUpload: true, UTextarea: true, UserAvatar: true, LayoutLoadError: true,
    UButton: { props: ['label', 'disabled', 'loading'], template: '<button type="button" :disabled="disabled || loading">{{ label }}</button>' },
  } } })
  await flushPromises()
  return { view, api, toast, close: () => { view.unmount(); client.clear() } }
}

it('deletes an agent only after confirming what stops and what stays', async () => {
  const { view, api, toast, close } = await editor()
  try {
    const buttons = () => view.findAll('button').filter(button => button.text() === 'Delete agent')
    expect(buttons()).toHaveLength(1)
    await buttons()[0]!.trigger('click')
    const dialog = view.get('[data-title="Delete Helper?"]')
    expect(dialog.text()).toContain('Run history and audit entries stay')
    expect(api.mock.calls.some(([, opts]) => opts?.method === 'DELETE')).toBe(false)
    await dialog.findAll('button').find(button => button.text() === 'Delete agent')!.trigger('click')
    await flushPromises()
    expect(api).toHaveBeenCalledWith('/api/servers/fixture-server/agents/fixture-agent', { method: 'DELETE' })
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Helper deleted', description: '1 run stopped, 2 tasks unassigned' }))
  } finally { close() }
})

it('hides the action from people who cannot manage agents', async () => {
  const { view, close } = await editor(false)
  try { expect(view.findAll('button').some(button => button.text() === 'Delete agent')).toBe(false) }
  finally { close() }
})
