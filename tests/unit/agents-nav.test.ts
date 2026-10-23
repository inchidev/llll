// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { computed, reactive, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import AgentsNav from '../../app/components/layout/AgentsNav.vue'
import NavThreads from '../../app/components/layout/NavThreads.vue'

afterEach(() => vi.unstubAllGlobals())

it('lists agent conversation threads, follows thread-only navigation and preserves unread badges', async () => {
  const route = reactive({ params: { channel: 'dm', threadId: 'first' } })
  const user = { id: 'agent', kind: 'agent', displayName: 'Helper' }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  for (const [name, value] of Object.entries({
    computed, useRoute: () => route, useRouter: () => ({ currentRoute: ref(route) }),
    useApi: () => ({ api: vi.fn().mockResolvedValue({ channels: [{ id: 'dm', serverId: 'server', type: 'dm', participants: [user, { id: 'me', kind: 'human' }] }], threads: [
      { id: 'first', parentId: 'dm', title: 'First question', unread: false, unreadCount: 0 },
      { id: 'second', parentId: 'dm', title: 'Second question', unread: true, unreadCount: 2 },
    ] }) }),
    useAgentDirectory: () => ({ agents: ref([{ user }]), members: { isPending: ref(false), error: ref(null) }, messageAgent: vi.fn() }),
    useMessagePrefetch: () => ({ intent: vi.fn(), cancel: vi.fn(), prefetch: vi.fn() }),
  })) vi.stubGlobal(name, value)
  const view = mount(AgentsNav, { props: { serverId: 'server' }, global: {
    plugins: [[VueQueryPlugin, { queryClient: client }]],
    stubs: {
      LayoutNavRow: { props: ['to', 'active'], template: '<a :href="to" :aria-current="active ? \'page\' : undefined"><slot /><slot name="trailing" /></a>' },
      LayoutNavThreads: NavThreads, LayoutSkeleton: true, LayoutLoadError: true,
      UserAvatar: true, UIcon: true, UBadge: { props: ['label'], template: '<span>{{ label }}</span>' },
    },
  } })
  try {
    await flushPromises()
    expect(view.findAll('a').map(link => link.attributes('href'))).toEqual(['/agents/dm/threads/first', '/agents/dm/threads/second'])
    expect(view.get('[aria-current="page"]').text()).toBe('First question')
    expect(view.text()).toContain('Second question 2')
    route.params.threadId = 'second'
    await flushPromises()
    expect(view.get('[aria-current="page"]').text()).toBe('Second question')
  } finally { view.unmount(); client.clear() }
})
