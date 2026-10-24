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
function render(api: ReturnType<typeof vi.fn>) {
  for (const [name, value] of Object.entries({ computed, ref, toValue, definePageMeta: () => {}, useInbox, useApi: () => ({ api }), useServer: () => ({ serverId: ref('server') }), useSessionStore: () => ({ user: { id: 'me' } }), useRoute: () => ({ query: {} }), useMessagePrefetch: () => ({ intent() {}, cancel() {}, prefetch() {} }) })) vi.stubGlobal(name, value)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
  const view = mount(InboxPage, { global: { plugins: [[VueQueryPlugin, { queryClient: client }]], stubs: {
    LayoutPageHeader: { template: '<header><slot name="meta"/><slot name="actions"/></header>' },
    LayoutLoadError: { props: ['message', 'retry'], template: '<aside>{{ message }}<button @click="retry()">Retry failed</button></aside>' },
    LayoutSkeleton: { template: '<p>Loading conversations</p>' }, LayoutEmptyState: { props: ['title'], template: '<p>{{ title }}</p>' },
    UButton: { props: ['label'], template: '<button>{{ label }}</button>' }, NuxtLink: { template: '<a><slot/></a>' }, UIcon: true, UBadge: true,
  } } }); wrappers.push(view); return view
}
it.each(['channels', 'dms'])('keeps the successful list when %s fails and retries only that source', async failed => {
  let broken = true
  const api = vi.fn(async (path: string) => {
    const source = path.endsWith('/dms') ? 'dms' : 'channels'
    if (broken && source === failed) throw Error('Unavailable')
    return { channels: [channel(source === 'dms' ? 'dm-conversation' : 'channel-conversation', source === 'dms' ? 'dm' : 'text')] }
  })
  const view = render(api)
  await flushPromises(); await new Promise(resolve => setTimeout(resolve, 20)); await flushPromises()
  expect(view.text()).toContain(failed === 'channels' ? 'dm-conversation' : 'channel-conversation')
  expect(view.text()).toContain('did not load')
  expect(view.text()).not.toContain("You're all caught up")
  expect(view.text()).not.toContain('No unread conversations here')
  broken = false; api.mockClear()
  await view.get('aside button').trigger('click')
  await flushPromises(); await new Promise(resolve => setTimeout(resolve, 20)); await flushPromises()
  expect(api).toHaveBeenCalledTimes(1)
  expect(api.mock.calls[0]?.[0]).toBe(failed === 'dms' ? '/api/dms' : '/api/servers/server/channels')
  expect(view.text()).toContain('dm-conversation'); expect(view.text()).toContain('channel-conversation')
  expect(view.find('aside').exists()).toBe(false)
})
it('does not claim the inbox is empty when both sources fail', async () => {
  const view = render(vi.fn(async () => { throw Error('Unavailable') }))
  await flushPromises(); await new Promise(resolve => setTimeout(resolve, 20)); await flushPromises()
  expect(view.text()).toContain('Channels and direct messages did not load')
  expect(view.text()).not.toContain("You're all caught up")
})
it('shows available conversations while another source is still loading', async () => {
  const view = render(vi.fn(async (path: string) => path.endsWith('/dms') ? new Promise(() => {}) : { channels: [channel('loaded-channel')] }))
  await flushPromises(); await new Promise(resolve => setTimeout(resolve, 20)); await flushPromises()
  expect(view.text()).toContain('loaded-channel')
  expect(view.text()).not.toContain('Loading conversations')
})
