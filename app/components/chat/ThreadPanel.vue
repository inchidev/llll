<script setup lang="ts">
import { useWindowSize } from '@vueuse/core'
import { useQuery } from '@tanstack/vue-query'
import type { ChannelDTO, ClientMsg, MemberDTO, MessageDTO } from '~~/shared/types'
import { hasPermission, Permission } from '~~/shared/permissions'
import { channelPath } from '~~/shared/paths'
import { threadTitle as messageThreadTitle } from '~~/shared/threads'
import { PENDING_THREAD_PREFIX } from '~/stores/ui'

const props = defineProps<{
  serverId: string
  members: MemberDTO[]
  canPin?: boolean
  canModerate?: boolean
  canCreateTasks?: boolean
  agentId?: string
}>()
const ui = useUiStore()
// A thread can take most of the window; the conversation beside it keeps room to read.
const { width: windowWidth } = useWindowSize()
const threadMaxWidth = computed(() => Math.max(640, windowWidth.value - 700))
const creating = computed(() => Boolean(ui.threadId?.startsWith(PENDING_THREAD_PREFIX)))
// While the thread is being created there is nothing to load or connect to yet.
const threadId = computed(() => creating.value ? '' : ui.threadId)
const { api } = useApi()
const { send, retry } = useChannelSocket(computed(() => threadId.value || ''))
const threadQ = useQuery({
  queryKey: computed(() => ['channel', threadId.value]),
  queryFn: ({ queryKey, signal }) => api<{ channel: ChannelDTO }>(`/api/channels/${queryKey[1]}`, { signal, timeout: 15_000 }),
  enabled: computed(() => Boolean(threadId.value)),
})
const threadName = computed(() => creating.value ? ui.pendingThreadTitle : threadQ.data.value?.channel.name || 'Thread')
const rootMessage = shallowRef<MessageDTO | null>(null)
const threadTitle = computed(() => threadQ.data.value?.channel.title
  || (rootMessage.value?.threadId === threadId.value
    ? messageThreadTitle(rootMessage.value.content, rootMessage.value.attachments.map(attachment => attachment.filename))
    : threadName.value))
const { mine } = usePermissions(computed(() => props.members))
const effectivePermissions = computed(() => threadQ.data.value?.channel.permissions ?? mine.value?.role.permissions ?? 0)
const canSendMessages = computed(() => hasPermission(effectivePermissions.value, Permission.sendMessages))
const canAttachFiles = computed(() => hasPermission(effectivePermissions.value, Permission.attachFiles))
/** A Thread follows its parent channel: archived history stays readable but takes no replies. */
const archived = computed(() => Boolean(threadQ.data.value?.channel.archivedAt))
const presence = usePresenceStore()
const agentBusy = computed(() => Boolean(threadId.value && presence.agentTurnsIn(threadId.value).length))
const canApproveAgent = computed(() => hasPermission(effectivePermissions.value, Permission.approveAgentActions))

// The router's live route: the page-level route misses thread-only URL changes.
const liveRoute = useRouter().currentRoute
const parentChannel = computed(() => {
  const id = ui.threadParentId || ''
  return liveRoute.value.path.startsWith('/agents/') ? { id, type: 'dm', participants: [{ kind: 'agent' }] } : id
})
function close() {
  const parentId = ui.threadParentId
  const parentPath = channelPath(parentChannel.value)
  ui.threadId = null
  ui.threadParentId = null
  // A thread opened by URL returns to its channel's URL.
  if (liveRoute.value.params.threadId && parentId) void navigateTo(parentPath, { replace: true })
}

function onReply(id: string) {
  if (threadId.value) ui.startReply(threadId.value, id)
}
const linkPath = computed(() => ui.threadParentId && threadId.value ? channelPath(parentChannel.value, threadId.value) : undefined)

defineShortcuts({
  escape: () => {
    if (ui.threadId) close()
  },
})
</script>

<template>
  <aside
    v-if="ui.threadId"
    id="channel-details"
    class="absolute inset-x-0 bottom-[calc(-1*var(--df-safe-area-bottom))] top-[calc(-1*var(--df-safe-area-top))] z-30 flex min-h-0 w-full shrink-0 flex-col border-l border-default bg-elevated dark:bg-black pb-[var(--df-safe-area-bottom)] pt-[var(--df-safe-area-top)] lg:relative lg:inset-auto lg:z-auto lg:w-[var(--df-right-panel-width)] lg:p-0"
    :style="{ '--df-right-panel-width': `${Math.min(ui.rightPanelWidth, threadMaxWidth)}px` }"
    aria-label="Thread"
  >
    <LayoutResizeHandle
      v-model="ui.rightPanelWidth"
      class="hidden lg:block"
      :min="180"
      :max="threadMaxWidth"
      side="start"
      label="Resize thread panel"
    />
    <header class="flex h-12 shrink-0 min-w-0 items-center gap-2 border-b border-default bg-elevated px-2 dark:bg-black">
      <UTooltip text="Close thread">
        <UButton class="size-10 shrink-0 justify-center md:size-8" size="sm" color="neutral" variant="ghost" icon="i-ph-arrow-right" aria-label="Close thread" @click="close" />
      </UTooltip>
      <span class="min-w-0 truncate text-sm font-semibold">{{ threadTitle }}</span>
      <UBadge label="Thread" color="neutral" variant="subtle" size="sm" class="shrink-0" />
    </header>
    <LayoutLoadError v-if="threadQ.error.value" inline class="shrink-0 py-2" message="Thread details did not load." :retry="threadQ.refetch" />
    <div v-if="creating" class="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted" role="status">
      <UIcon name="i-ph-circle-notch" class="size-5 animate-spin" />
      Creating thread…
    </div>
    <template v-else-if="threadId">
    <ChatMessageList
      :channel-id="threadId"
      :members="members"
      :channel-name="threadTitle"
      :show-intro="false"
      :can-pin="props.canPin"
      :can-moderate="props.canModerate"
      :can-create-tasks="props.canCreateTasks"
      :read-only="archived"
      :allow-threads="false"
      :link-path="linkPath"
      @root-message="rootMessage = $event"
      @reply="onReply"
      @read="(messageId) => send({ t: 'read', messageId })"
      @retry="retry"
    />
    <ChatComposer
      :channel-id="threadId"
      :server-id="props.serverId"
      :members="props.members"
      :send="send as (msg: ClientMsg) => void"
      :disabled="!canSendMessages"
      :disabled-placeholder="archived ? 'This channel is archived' : undefined"
      :can-attach="canAttachFiles"
      :agent-busy="agentBusy"
      :agent-id="agentId"
      placeholder="Reply in thread"
    >
      <template #activity><ChatAgentActivity :channel-id="threadId" :members="members" :send="send as (msg: ClientMsg) => void" :can-approve="canApproveAgent" /></template>
    </ChatComposer>
    </template>
  </aside>
</template>
