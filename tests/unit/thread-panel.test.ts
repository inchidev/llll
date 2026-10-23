// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computed, defineComponent, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import ThreadPanel from '../../app/components/chat/ThreadPanel.vue'
import type { MessageDTO } from '../../shared/types'

const original: MessageDTO = {
  id: 'original', channelId: 'parent', serverId: 'server',
  author: { id: 'human', kind: 'human', displayName: 'inchi', avatarR2Key: null },
  content: 'hi', threadId: 'thread', replyTo: null, mentions: [], attachments: [], reactions: [], pin: null,
  editedAt: null, deletedAt: null, createdAt: '2026-10-23T00:00:00Z',
}
let client: QueryClient
let view: VueWrapper | undefined
let ui: { threadId: string | null; threadParentId: string | null; pendingThreadTitle: string }
let api: ReturnType<typeof vi.fn>
const Messages = defineComponent({
  emits: ['rootMessage'],
  setup(_, { emit }) { onMounted(() => emit('rootMessage', original)) },
  template: '<div>First reply</div>',
})
const Button = { props: ['icon'], template: '<button :data-icon="icon"><slot /></button>' }

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  ui = reactive({ threadId: 'thread', threadParentId: 'parent', pendingThreadTitle: '' })
  api = vi.fn(() => new Promise(() => {}))
  for (const [name, value] of Object.entries({
    computed, ref, shallowRef, watch,
    useUiStore: () => ui, useApi: () => ({ api }),
    useChannelSocket: () => ({ send: vi.fn(), retry: vi.fn() }),
    usePermissions: () => ({ mine: ref(null) }),
    usePresenceStore: () => ({ agentTurnsIn: () => [] }),
    useRouter: () => ({ currentRoute: ref({ path: '/agents/parent', params: {} }) }),
    defineShortcuts: vi.fn(), navigateTo: vi.fn(),
  })) vi.stubGlobal(name, value)
})
afterEach(() => { view?.unmount(); view = undefined; client.clear(); vi.unstubAllGlobals() })

function open() {
  view = mount(ThreadPanel, { props: { serverId: 'server', members: [] }, global: {
    plugins: [[VueQueryPlugin, { queryClient: client }]],
    stubs: {
      ChatMessageList: Messages, ChatAgentActivity: true, ChatComposer: true, LayoutResizeHandle: true,
      UTooltip: { template: '<span><slot /></span>' }, UButton: Button, UIcon: true,
      UBadge: { props: ['label'], template: '<span>{{ label }}</span>' }, USkeleton: { template: '<span>Loading title</span>' },
      LayoutLoadError: { props: ['message', 'retry'], template: '<button @click="retry">{{ message }}</button>' },
    },
  } })
  return view
}

it('shows the original message title while the independent metadata request is still pending', async () => {
  const panel = open()
  await flushPromises()
  expect(panel.get('header').text()).toContain('hi')
  expect(panel.get('header').text()).not.toContain('Loading title')
})

it('lets a failed metadata request be retried and keeps the thread content visible', async () => {
  api.mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValueOnce({ channel: { name: 'hi', title: 'hi', permissions: 0 } })
  const panel = open()
  await flushPromises()
  const retry = panel.findAll('button').find(button => button.text().includes('Thread details did not load'))
  expect(retry).toBeDefined()
  await retry!.trigger('click')
  await flushPromises()
  expect(api).toHaveBeenCalledTimes(2)
  expect(panel.text()).toContain('First reply')
})
