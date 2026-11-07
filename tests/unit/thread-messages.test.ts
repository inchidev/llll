// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, nextTick, onMounted, onUnmounted, ref, watch, watchEffect } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import MessageList from '../../app/components/chat/MessageList.vue'
import type { MessageDTO } from '../../shared/types'

// DOM layout is not available here; keep the real list/query logic and expose its rows.
vi.mock('@tanstack/vue-virtual', async () => {
  const { computed } = await import('vue')
  return { useVirtualizer: (options: { value: { count: number; getItemKey: (index: number) => string } }) => computed(() => ({
    getVirtualItems: () => Array.from({ length: options.value.count }, (_, index) => ({ index, key: options.value.getItemKey(index), start: index * 84 })),
    getTotalSize: () => options.value.count * 84,
    measureElement: vi.fn(), scrollToEnd: vi.fn(), scrollToOffset: vi.fn(),
  })) }
})

function message(id: string, channelId: string, content: string): MessageDTO {
  return { id, channelId, content, serverId: 'server', author: { id: 'human', kind: 'human', displayName: 'inchi', avatarR2Key: null },
    replyTo: null, mentions: [], attachments: [], reactions: [], pin: null, threadId: channelId === 'parent' ? 'thread' : null,
    editedAt: null, deletedAt: null, createdAt: '2026-10-23T00:00:00Z' }
}
const root = message('original', 'parent', 'My first message')
const reply = message('reply', 'thread', 'The reply')
let client: QueryClient
let view: VueWrapper | undefined

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  for (const [name, value] of Object.entries({
    computed, ref, watch, watchEffect, onMounted, onUnmounted, nextTick,
    refDebounced: (source: unknown) => source,
    useApi: () => ({ api: vi.fn(async () => ({ messages: [reply], rootMessage: root, nextCursor: null })) }),
    useSessionStore: () => ({ user: { id: 'human' } }),
    usePresenceStore: () => ({ agentTurnsIn: () => [], agentStreamsIn: () => [] }),
    usePermissions: () => ({ mine: ref(null), can: () => false }),
    useUiStore: () => ({ searchQuery: '', searchOpen: false, threadId: 'thread', composerState: () => ({ editingId: null }) }),
    usePrefsStore: () => ({ compact: false, recentEmoji: [] }),
    useToast: () => ({ add: vi.fn() }),
    useServer: () => ({ serverId: ref('server') }),
    useRouter: () => ({ currentRoute: ref({ path: '/agents/parent', params: {}, query: {} }) }),
  })) vi.stubGlobal(name, value)
})
afterEach(() => { view?.unmount(); view = undefined; client.clear(); vi.unstubAllGlobals() })

function open() {
  view = mount(MessageList, { props: { channelId: 'thread', members: [], showIntro: false, allowThreads: false }, global: {
    plugins: [[VueQueryPlugin, { queryClient: client }]],
    stubs: {
      UContextMenu: { template: '<div><slot /></div>' }, UModal: true, UDrawer: true, LayoutSkeleton: true, LayoutLoadError: true,
      ChatMessageItem: { props: ['message', 'contextOnly'], template: '<article :data-context-only="contextOnly">{{ message.content }}</article>' },
    },
  } })
  return view
}

it('renders the original before replies without treating it as a message in the thread channel', async () => {
  const list = open()
  await flushPromises()
  expect(list.findAll('article').map(item => item.text())).toEqual(['My first message', 'The reply'])
  expect(list.findAll('article')[0]?.attributes('data-context-only')).toBe('true')
  expect(list.emitted('rootMessage')?.at(-1)).toEqual([root])
})

it('shows the original immediately for a freshly created, cached thread without replies', async () => {
  client.setQueryData(['messages', 'thread'], { pages: [{ messages: [], rootMessage: root, nextCursor: null }], pageParams: [undefined] })
  const list = open()
  await flushPromises()
  expect(list.findAll('article').map(item => item.text())).toEqual(['My first message'])
  expect(list.emitted('read')).toBeUndefined()
})

describe('reads', () => {
  let generation = 0
  const api = vi.fn(async (url: string) => url.endsWith('/attention')
    ? { following: false, notifications: 'default', readGeneration: generation }
    : { messages: [message('m1', url.split('/')[3]!, 'One')], rootMessage: null, nextCursor: null, lastReadMessageId: null })
  const settle = async () => { await flushPromises(); await nextTick(); await flushPromises() }
  beforeEach(() => {
    generation = 0
    api.mockClear()
    vi.stubGlobal('useApi', () => ({ api }))
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  })
  const reads = (list: VueWrapper) => (list.emitted('read') ?? []) as Array<[string, number]>

  it('asks afresh on returning to a conversation inside staleTime, so reads do not stall', async () => {
    const list = open()
    await settle()
    expect(reads(list).at(-1)).toEqual(['m1', 0])
    await list.setProps({ channelId: 'other' })
    await settle()
    expect(reads(list).at(-1)).toEqual(['m1', 0])
    const before = reads(list).length
    await list.setProps({ channelId: 'thread' })
    await settle()
    expect(api.mock.calls.filter(([url]) => url === '/api/channels/thread/attention')).toHaveLength(2)
    expect(reads(list).length).toBe(before + 1)
  })

  it('stays paused after another tab marks unread, and resumes with the new generation on a newer message', async () => {
    const list = open()
    await settle()
    expect(reads(list)).toEqual([['m1', 0]])
    client.setQueryData(['chat-read-generation', 'thread'], 3)
    await settle()
    expect(reads(list)).toHaveLength(1)
    client.setQueryData(['messages', 'thread'], { pages: [{ messages: [message('m1', 'thread', 'One'), message('m2', 'thread', 'Two')], rootMessage: null, nextCursor: null }], pageParams: [undefined] })
    await settle()
    expect(reads(list).at(-1)).toEqual(['m2', 3])
  })
})
