// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { computed, ref, shallowRef } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import { Permission } from '../../shared/permissions'
import EmptyState from '../../app/components/layout/EmptyState.vue'

afterEach(() => vi.unstubAllGlobals())
async function setup(manager: boolean, paused: boolean) {
  const agent = { user: { id: 'paused-agent', kind: 'agent', displayName: 'Sleeping agent' }, agentStatus: 'paused', role: { name: 'Member' } }
  const directory = ref(paused ? [agent] : [])
  const messageAgent = vi.fn()
  for (const [name, value] of Object.entries({ computed, ref, shallowRef,
    definePageMeta: () => {}, useServer: () => ({ serverId: ref('server') }),
    useApi: () => ({ api: vi.fn(async () => ({ agents: [] })) }),
    useRoleGrants: () => ({ can: (permission: number) => permission === Permission.manageAgents ? manager : true }),
    useNavActions: () => ({ createAgentOpen: ref(false) }),
    useAgentDirectory: () => ({ agents: directory, members: { isPending: ref(false), error: ref(null) }, messageAgent, opening: ref(null) }),
  })) vi.stubGlobal(name, value)
  const Page = (await import('../../app/pages/agents/index.vue')).default
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = mount(Page, { global: { plugins: [[VueQueryPlugin, { queryClient: client }]], stubs: {
    LayoutPageHeader: { template: '<header><slot name="actions" /></header>' },
    LayoutEmptyState: EmptyState, LayoutSkeleton: true, LayoutLoadError: true, SettingsAgentEditorModal: true,
    UserAvatar: true, UIcon: true, UInput: true,
    UBadge: { props: ['label'], template: '<span>{{ label }}</span>' },
    UButton: { props: ['label', 'disabled'], emits: ['click'], template: '<button :disabled="disabled" @click="$emit(\'click\')">{{ label }}</button>' },
  } } })
  await flushPromises()
  return { view, directory, messageAgent, close: () => { view.unmount(); client.clear() } }
}
it('marks a paused agent and disables Message until it resumes', async () => {
  const f = await setup(true, true)
  try {
    expect(f.view.text()).toContain('Paused')
    expect(f.view.get('[aria-label="Message Sleeping agent"]').attributes('disabled')).toBeDefined()
    expect(f.view.get('[aria-label="Message Sleeping agent"]').attributes('title')).toContain('paused')
    f.directory.value[0]!.agentStatus = 'active'
    await flushPromises()
    expect(f.view.get('[aria-label="Message Sleeping agent"]').attributes('disabled')).toBeUndefined()
    await f.view.get('[aria-label="Message Sleeping agent"]').trigger('click')
    expect(f.messageAgent).toHaveBeenCalledWith('paused-agent')
  } finally { f.close() }
})
it.each([true, false])('offers an appropriate empty state when manager=%s', async manager => {
  const f = await setup(manager, false)
  try {
    expect(f.view.text()).toContain(manager ? 'Create an agent to start working together.' : 'Ask a server administrator to add an agent.')
    expect(f.view.findAll('button').some(button => button.text() === 'Create agent')).toBe(manager)
  } finally { f.close() }
})
