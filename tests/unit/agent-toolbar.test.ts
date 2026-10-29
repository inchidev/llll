// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { computed, ref, watch } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import Toolbar from '../../app/components/chat/AgentToolbar.vue'

const wrappers: ReturnType<typeof mount>[] = [], clients: QueryClient[] = []
afterEach(() => { wrappers.splice(0).forEach(view => view.unmount()); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals() })
const running = { id: 'running', status: 'running', agentId: 'agent', initiatedBy: 'me', channelId: 'chat', prompt: 'Working' }
const queued = (id: string) => ({ ...running, id, prompt: id, status: 'queued' })
async function settle() { await flushPromises(); await new Promise(resolve => setTimeout(resolve, 15)); await flushPromises() }
function render(api: ReturnType<typeof vi.fn>) {
  const toast = vi.fn()
  for (const [name, value] of Object.entries({ computed, ref, watch, useApi: () => ({ api }), useSessionStore: () => ({ user: { id: 'me' } }), usePresenceStore: () => ({ agentTurnsIn: () => [] }), useToast: () => ({ add: toast }), errorMessage: (error: Error) => error.message })) vi.stubGlobal(name, value)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
  const view = mount(Toolbar, { props: { channelId: 'chat', agentId: 'agent', send: () => {} }, global: { plugins: [[VueQueryPlugin, { queryClient: client }]], stubs: {
    UIcon: true, UBadge: true, USelectMenu: true, UTooltip: { template: '<span><slot/></span>' },
    UButton: { props: ['label', 'disabled'], template: '<button :disabled="disabled">{{ label }}<slot/></button>' },
    LayoutLoadError: { props: ['message'], template: '<p>{{ message }}</p>' },
  } } }); wrappers.push(view); return { view, client, toast }
}
it('refreshes two queue cycles without a reload even while the model catalog hangs', async () => {
  let active = [running, queued('QUEUE_A')]
  const api = vi.fn(async (path: string) => {
    if (path.endsWith('/agent-model')) return new Promise(() => {})
    if (path.endsWith('/steer')) { active = []; return { status: 'steered' } }
    return { active }
  })
  const { view, client } = render(api); await settle()
  expect(view.text()).toContain('QUEUE_A')
  active = []; await client.invalidateQueries({ queryKey: ['agent-conversation-runs'] }); await settle()
  expect(view.text()).not.toContain('QUEUE_A')
  active = [running, queued('QUEUE_B')]; await client.invalidateQueries({ queryKey: ['agent-conversation-runs'] }); await settle()
  expect(view.text()).toContain('QUEUE_B'); expect(view.text()).not.toContain('QUEUE_A')
  await view.findAll('button').find(button => button.text() === 'Steer')!.trigger('click'); await settle()
  expect(api.mock.calls.filter(([path]) => path.endsWith('/steer')).map(([path]) => path)).toEqual(['/api/agent-runs/QUEUE_B/steer'])
  expect(view.text()).not.toContain('QUEUE_B')
})
it('rejects a stale displayed row and refreshes to the current queued message without steering it', async () => {
  let active = [running, queued('OLD_QUEUE')]
  const api = vi.fn(async (path: string) => path.endsWith('/agent-model') ? { models: [], active: [] } : { active })
  const { view, toast } = render(api); await settle()
  active = [running, queued('NEW_QUEUE')]
  await view.findAll('button').find(button => button.text() === 'Steer')!.trigger('click'); await settle()
  expect(api.mock.calls.some(([path]) => path.endsWith('/steer'))).toBe(false)
  expect(view.text()).toContain('NEW_QUEUE'); expect(view.text()).not.toContain('OLD_QUEUE')
  expect(toast.mock.calls[0]?.[0].title).toContain('no longer available')
})
it('refreshes controls after an action loses a completion race', async () => {
  let active = [running, queued('RACING_QUEUE')]
  const api = vi.fn(async (path: string) => {
    if (path.endsWith('/agent-model')) return { models: [], active: [] }
    if (path.endsWith('/steer')) { active = []; throw Error('The agent is no longer working on this conversation') }
    return { active }
  })
  const { view, toast } = render(api); await settle()
  await view.findAll('button').find(button => button.text() === 'Steer')!.trigger('click'); await settle()
  expect(toast).toHaveBeenCalled(); expect(view.text()).not.toContain('RACING_QUEUE')
})
it('says a reply runs in a thread instead of offering a second Stop', async () => {
  const api = vi.fn(async (path: string) => path.endsWith('/agent-model') ? { models: [], active: [] } : { active: [{ ...running, channelId: 'thread' }] })
  const { view } = render(api); await settle()
  expect(view.find('[aria-label="Stop agent"]').exists()).toBe(false)
  expect(view.html()).toContain('Replying in thread')
})
