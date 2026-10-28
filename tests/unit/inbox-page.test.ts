// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { computed, ref, toValue } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import InboxPage from '../../app/pages/inbox.vue'
import { useInbox } from '../../app/composables/useInbox'

const wrappers: ReturnType<typeof mount>[] = []
const clients: QueryClient[] = []
afterEach(() => { wrappers.splice(0).forEach(view => view.unmount()); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals() })
const channel = (id: string, type = 'text') => ({ id, name: id, type, serverId: 'server', unread: true, createdAt: '2026-10-24', participants: [] })
const inbox = { approvals: [], mentions: [], runs: [], review: [], assigned: [{ id: 't1', number: 7, title: 'assigned-task', status: 'ready', priority: 'normal', dueAt: null, boardName: 'Roadmap' }] }
type Source = 'inbox' | 'channels' | 'dms' | 'mailboxes'
const source = (path: string): Source => path.endsWith('/inbox') ? 'inbox' : path.endsWith('/dms') ? 'dms' : path.endsWith('/mailboxes') ? 'mailboxes' : 'channels'
const response = (from: Source) => from === 'inbox' ? inbox : from === 'mailboxes' ? { mailboxes: [] }
  : { channels: [channel(from === 'dms' ? 'dm-conversation' : 'channel-conversation', from === 'dms' ? 'dm' : 'text')] }
const settle = async () => { await flushPromises(); await new Promise(resolve => setTimeout(resolve, 20)); await flushPromises() }
function render(api: ReturnType<typeof vi.fn>) {
  for (const [name, value] of Object.entries({ computed, ref, toValue, definePageMeta: () => {}, useInbox, useApi: () => ({ api }), useServer: () => ({ serverId: ref('server') }), useSessionStore: () => ({ user: { id: 'me' } }), useRoute: () => ({ query: {} }), useMessagePrefetch: () => ({ intent() {}, cancel() {}, prefetch() {} }), useToast: () => ({ add() {} }) })) vi.stubGlobal(name, value)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
  const view = mount(InboxPage, { global: { plugins: [[VueQueryPlugin, { queryClient: client }]], stubs: {
    LayoutPageHeader: { template: '<header><slot name="meta"/><slot name="actions"/></header>' },
    LayoutLoadError: { props: ['message', 'retry'], template: '<aside>{{ message }}<button @click="retry()">Retry failed</button></aside>' },
    LayoutSkeleton: { template: '<p>Loading inbox</p>' }, LayoutEmptyState: { props: ['title'], template: '<p>{{ title }}</p>' },
    UButton: { props: ['label'], template: '<button>{{ label }}</button>' }, NuxtLink: { template: '<a><slot/></a>' }, UIcon: true, UBadge: true, UserAvatar: true, UTooltip: { template: '<span><slot/></span>' },
  } } }); wrappers.push(view); return view
}

it.each(['inbox', 'channels', 'dms'] as const)('keeps what loaded when %s fails and retries only that source', async failed => {
  let broken = true
  const api = vi.fn(async (path: string) => {
    if (broken && source(path) === failed) throw Error('Unavailable')
    return response(source(path))
  })
  const view = render(api)
  await settle()
  if (failed !== 'inbox') expect(view.text()).toContain('assigned-task')
  if (failed !== 'channels') expect(view.text()).toContain('channel-conversation')
  expect(view.text()).toContain('did not load')
  expect(view.text()).not.toContain("You're all caught up")
  broken = false; api.mockClear()
  await view.get('aside button').trigger('click')
  await settle()
  expect(api.mock.calls.map(call => source(call[0] as string))).toEqual([failed])
  expect(view.text()).toContain('assigned-task'); expect(view.text()).toContain('dm-conversation')
  expect(view.find('aside').exists()).toBe(false)
})

it('does not claim the inbox is empty when every source fails', async () => {
  const view = render(vi.fn(async () => { throw Error('Unavailable') }))
  await settle()
  expect(view.text()).toContain('did not load')
  expect(view.text()).not.toContain("You're all caught up")
})

it('shows unread chats while the rest of the inbox is still loading, without calling it empty', async () => {
  const view = render(vi.fn(async (path: string) => source(path) === 'inbox' ? new Promise(() => {}) : response(source(path))))
  await settle()
  expect(view.text()).toContain('channel-conversation')
  expect(view.text()).not.toContain('Loading inbox')
  expect(view.text()).not.toContain("You're all caught up")
})
