<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { ChannelDTO, ClientMsg, MemberDTO } from '~~/shared/types'
import { hasPermission, Permission } from '~~/shared/permissions'
import { channelPath } from '~~/shared/paths'
import { PENDING_THREAD_PREFIX } from '~/stores/ui'

const props = defineProps<{
  workspaceId: string
  members: MemberDTO[]
  canPin?: boolean
}>()
const ui = useUiStore()
const creating = computed(() => Boolean(ui.threadId?.startsWith(PENDING_THREAD_PREFIX)))
// While the thread is being created there is nothing to load or connect to yet.
const threadId = computed(() => creating.value ? '' : ui.threadId)
const { api } = useApi()
const { send, retry } = useChannelSocket(computed(() => threadId.value || ''))
const threadQ = useQuery({
  queryKey: computed(() => ['channel', threadId.value]),
  queryFn: () => api<{ channel: ChannelDTO }>(`/api/channels/${threadId.value}`),
  enabled: computed(() => Boolean(threadId.value)),
})
const threadName = computed(() => creating.value ? ui.pendingThreadTitle : threadQ.data.value?.channel.name || 'Thread')
const threadTitle = computed(() => threadQ.data.value?.channel.title || threadName.value)
const { mine } = usePermissions(computed(() => props.members))
const effectivePermissions = computed(() => threadQ.data.value?.channel.permissions ?? mine.value?.role.permissions ?? 0)
const canSendMessages = computed(() => hasPermission(effectivePermissions.value, Permission.sendMessages))
const canAttachFiles = computed(() => hasPermission(effectivePermissions.value, Permission.attachFiles))
const presence = usePresenceStore()
const agentBusy = computed(() => Boolean(threadId.value && presence.agentTurnsIn(threadId.value).length))
const canApproveAgent = computed(() => hasPermission(effectivePermissions.value, Permission.manageWorkspace))

// The router's live route: the page-level route misses thread-only URL changes.
const liveRoute = useRouter().currentRoute
function close() {
  const parentId = ui.threadParentId
  ui.threadId = null
  ui.threadParentId = null
  // A thread opened by URL returns to its channel's URL.
  if (liveRoute.value.params.threadId && parentId) void navigateTo(channelPath(parentId), { replace: true })
}

function onReply(id: string) {
  if (threadId.value) ui.startReply(threadId.value, id)
}
const linkPath = computed(() => ui.threadParentId && threadId.value ? channelPath(ui.threadParentId, threadId.value) : undefined)

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
    class="absolute inset-x-0 bottom-[calc(-1*var(--df-safe-area-bottom))] top-[calc(-1*var(--df-safe-area-top))] z-30 flex min-h-0 w-full shrink-0 flex-col border-l border-default bg-elevated pb-[var(--df-safe-area-bottom)] pt-[var(--df-safe-area-top)] md:relative md:inset-auto md:z-auto md:w-[var(--df-right-panel-width)] md:p-0"
    :style="{ '--df-right-panel-width': `${ui.rightPanelWidth}px` }"
    aria-label="Thread"
  >
    <LayoutResizeHandle
      v-model="ui.rightPanelWidth"
      class="hidden md:block"
      :min="180"
      :max="640"
      side="start"
      label="Resize thread panel"
    />
    <header class="flex h-12 shrink-0 min-w-0 items-center gap-2 border-b border-default bg-elevated px-2">
      <UTooltip text="Back">
        <UButton class="size-10 shrink-0 justify-center md:size-8" size="sm" color="neutral" variant="ghost" icon="i-ph-arrow-left" aria-label="Back" @click="close" />
      </UTooltip>
      <USkeleton v-if="!creating && threadQ.isPending.value" class="h-3.5 w-32" />
      <span v-else class="min-w-0 truncate text-sm font-semibold">{{ threadTitle }}</span>
      <UBadge label="Thread" color="neutral" variant="subtle" size="sm" class="shrink-0" />
    </header>
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
      :allow-threads="false"
      :link-path="linkPath"
      @reply="onReply"
      @read="(messageId) => send({ t: 'read', messageId })"
      @retry="retry"
    />
    <ChatAgentActivity
      :channel-id="threadId"
      :members="members"
      :send="send as (msg: ClientMsg) => void"
      :can-approve="canApproveAgent"
    />
    <ChatComposer
      :channel-id="threadId"
      :workspace-id="props.workspaceId"
      :members="props.members"
      :send="send as (msg: ClientMsg) => void"
      :disabled="!canSendMessages"
      :can-attach="canAttachFiles"
      :agent-busy="agentBusy"
      placeholder="Reply in thread"
    />
    </template>
  </aside>
</template>
