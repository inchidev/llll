<script setup lang="ts">
import { useQuery, useQueryClient, type InfiniteData } from '@tanstack/vue-query'
import { onKeyStroke, useMediaQuery } from '@vueuse/core'
import type { ChannelDTO, MemberDTO, MessageDTO } from '~~/shared/types'
import type { LiveJoinOptions } from '../../composables/useLiveSession'
import type { RealtimeConnection } from '../../composables/useChannelSocket'
import { serverConnectionKey } from '../../composables/useServerSocket'
import { dmTitle, isDmType } from '~~/shared/dm'
import { channelPath } from '~~/shared/paths'
import { hasPermission, Permission } from '~~/shared/permissions'
import { isSearchShortcut } from '~~/shared/shortcuts'
import { liveJoinLabel, liveKindFor, liveStartLabel } from '~~/shared/live'
import { threadTitle } from '~~/shared/threads'
import { PENDING_THREAD_PREFIX } from '~/stores/ui'

const route = useRoute()
const ui = useUiStore()
const session = useSessionStore()
const presence = usePresenceStore()
const live = useLiveStore()
const qc = useQueryClient()
const toast = useToast()
const { serverId } = useServer()
const { api } = useApi()
const detailsOverlay = useMediaQuery('(max-width: 1023px)')
const channelId = computed(() => String(route.params.channel || route.params.channelId || ''))


onKeyStroke(
  isSearchShortcut,
  (event) => {
    event.preventDefault()
    ui.searchOpen = true
  },
)

const membersQ = useQuery({
  queryKey: computed(() => ['members', serverId.value]),
  queryFn: ({ queryKey }) => {
    const id = String(queryKey[1] ?? '')
    return id ? api<{ members: MemberDTO[] }>(`/api/servers/${id}/members`) : Promise.resolve({ members: [] })
  },
  enabled: computed(() => Boolean(serverId.value)),
})
const channelsQ = useQuery({
  queryKey: computed(() => ['channels', serverId.value]),
  queryFn: ({ queryKey }) => {
    const id = String(queryKey[1] ?? '')
    return id ? api<{ channels: ChannelDTO[] }>(`/api/servers/${id}/channels`) : Promise.resolve({ channels: [] })
  },
  enabled: computed(() => Boolean(serverId.value)),
})
const dmsQ = useQuery({
  queryKey: ['dms'],
  queryFn: () => api<{ channels: ChannelDTO[] }>('/api/dms'),
})
const attention = useAttention()
watch([() => channelsQ.data.value, () => dmsQ.data.value], () => attention.sync(), { deep: true })
const oneQ = useQuery({
  queryKey: computed(() => ['channel', channelId.value]),
  queryFn: () => api<{ channel: ChannelDTO; frozen?: boolean }>(`/api/channels/${channelId.value}`),
  enabled: computed(() => Boolean(channelId.value)),
})

const channel = computed(() => {
  return oneQ.data.value?.channel
    ?? dmsQ.data.value?.channels.find((c) => c.id === channelId.value)
    ?? channelsQ.data.value?.channels.find((c) => c.id === channelId.value)
})
const members = computed(() => membersQ.data.value?.members ?? [])
const type = computed(() => channel.value?.type || 'text')
const isDm = computed(() => isDmType(type.value))
const others = computed(() => (channel.value?.participants ?? []).filter((p) => p.id !== session.user?.id))
const directAgentId = computed(() => isDm.value && others.value[0]?.kind === 'agent' ? others.value[0].id : undefined)
const headerName = computed(() => {
  if (!isDm.value) return channel.value?.name || ''
  return channel.value?.title || dmTitle(channel.value?.name, channel.value?.participants ?? [], session.user?.id || '')
})
const frozen = computed(() => Boolean(oneQ.data.value?.frozen || channel.value?.frozen || ui.dmFrozen))
const { can, canAnyProject, mine } = usePermissions(members)
/** Writing Tasks anywhere offers Create task on messages; the board is chosen in the form. */
const canCreateTasks = computed(() => canAnyProject(Permission.writeTasks))
const canPin = computed(() => isDm.value ? !frozen.value : can(Permission.manageChannels))
const effectivePermissions = computed(() => channel.value?.permissions ?? mine.value?.role.permissions ?? 0)
const canSendMessages = computed(() => isDm.value ? !frozen.value : hasPermission(effectivePermissions.value, Permission.sendMessages))
const canAttachFiles = computed(() => (session.health?.bindings?.r2 !== false || session.health?.bindings?.kv) && (isDm.value ? !frozen.value : hasPermission(effectivePermissions.value, Permission.attachFiles)))
// Starting follows the role in Direct Messages too; anyone who can open the conversation can join.
const canStartLive = computed(() => !frozen.value && hasPermission(effectivePermissions.value, Permission.startLive))
const isConversation = computed(() => type.value !== 'thread')
// Until the channel and the member's role arrive, permissions are unknown rather
// than denied: keep the composer quietly disabled instead of claiming "cannot send".
const permissionsKnown = computed(() => Boolean(channel.value)
  && (isDm.value || channel.value?.permissions !== undefined || Boolean(mine.value)))
const composerDisabledPlaceholder = computed(() => {
  if (!permissionsKnown.value) return composerPlaceholder.value
  return frozen.value
    ? 'You can no longer send messages to this user'
    : 'You cannot send messages in this channel'
})
const isMobile = useIsMobile()
const composerPlaceholder = computed(() => {
  if (!headerName.value) return 'Message'
  if (isDm.value) return `Message @${headerName.value}`
  return `Message #${headerName.value}`
})

const { send, retry, connection: channelConnection } = useChannelSocket(channelId)
const serverConnection = inject(serverConnectionKey, ref<RealtimeConnection>('connected'))
const connection = computed(() => {
  if (channelConnection.value === 'offline' || serverConnection.value === 'offline') return 'offline'
  if (channelConnection.value === 'connected' && serverConnection.value === 'connected') return 'connected'
  if (channelConnection.value === 'reconnecting' || serverConnection.value === 'reconnecting') return 'reconnecting'
  return 'connecting'
})
// The live connection only carries new events; content loads over HTTP. So say
// nothing while it (re)connects normally, show a thin bar if reconnecting drags
// on, and a quiet icon when the device is offline.
const showConnection = ref(false)
let connectionTimer: ReturnType<typeof setTimeout> | undefined
watch(connection, (state) => {
  clearTimeout(connectionTimer)
  if (state === 'connected') showConnection.value = false
  else if (state === 'offline') showConnection.value = true
  else connectionTimer = setTimeout(() => { showConnection.value = true }, state === 'connecting' ? 8000 : 3000)
}, { immediate: true })
onBeforeUnmount(() => clearTimeout(connectionTimer))
const { join, leave, end } = useLiveSession(channelId, { leaveOnUnmount: false })

const prejoinOpen = ref(false)
const pairDm = computed(() => isDm.value)
const roomActive = computed(() => Boolean(live.state?.active))
const liveKind = computed(() => roomActive.value ? live.state!.kind : liveKindFor(pairDm.value))
const liveActionLabel = computed(() => roomActive.value ? liveJoinLabel(liveKind.value) : liveStartLabel(liveKind.value))
const callsUnavailable = computed(() => session.health?.capabilities?.calls === false)
const liveActionHint = computed(() => {
  if (callsUnavailable.value) return 'Calls use Cloudflare RealtimeKit and are unavailable on this runtime.'
  if (roomActive.value || canStartLive.value) return liveActionLabel.value
  return frozen.value ? 'You can no longer call in this Direct Message' : 'Your role cannot start live sessions here'
})
const joinedHere = computed(() => live.inRoom && live.currentChannelId === channelId.value)
const showStage = computed(() => joinedHere.value && live.expanded)
// Mirrors the server's host rule: the starter, or someone who manages this Channel.
// Mirrors the server's moderation rule: Manage channels after channel overrides, never in DMs.
const canModerate = computed(() => !isDm.value && hasPermission(effectivePermissions.value, Permission.manageChannels))
const canEndLive = computed(() => Boolean(
  live.state?.active
  && (live.state.startedBy === session.user?.id
    || (!isDm.value && hasPermission(effectivePermissions.value, Permission.manageChannels))),
))
// Hosts may also mute and remove people; both people in a 1:1 Call are hosts.
const isLiveHost = computed(() => Boolean(live.state?.active && (live.state.kind === 'call' || canEndLive.value)))

function openPrejoin() {
  live.error = null
  if (callsUnavailable.value) return
  // Say Live is not connected before asking for a camera and microphone.
  if (session.health?.realtimekit === false) {
    ui.liveSetupOpen = true
    return
  }
  prejoinOpen.value = true
}

async function confirmPrejoin(options: LiveJoinOptions) {
  try {
    await join({ ...options, title: headerName.value, kind: liveKind.value })
    if (live.connection === 'connected') prejoinOpen.value = false
  }
  catch { /* the prejoin modal renders the connection error */ }
}

async function endLive() {
  try { await end() }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
}

watch([serverId, channelId], () => {
  live.view(channelId.value)
}, { immediate: true })

// The thread URL is a child of this page's route, and the page-level route does
// not update when only the child changes, so follow the router's live route.
// A thread in the URL opens it; no thread closes it, and so does changing channel.
const liveRoute = useRouter().currentRoute
const linkedThread = computed(() => liveRoute.value.params.threadId ? String(liveRoute.value.params.threadId) : null)
watch([channelId, linkedThread], ([channel, thread]) => {
  ui.threadId = thread
  if (thread) {
    ui.threadParentId = channel
    ui.rightPanelOpen = true
    ui.rightPanelTab = 'threads'
  }
}, { immediate: true })

watch(channel, (next) => {
  if (next?.live) live.setState(next.id, next.live)
}, { immediate: true })

watch([() => live.pendingJoin, channelId], ([pending]) => {
  if (!pending || pending.channelId !== channelId.value) return
  openPrejoin()
  live.pendingJoin = null
}, { immediate: true })

watch(() => oneQ.data.value?.channel, (ch) => {
  if (!ch) return
  const want = channelPath(ch, linkedThread.value ?? undefined)
  if (want.startsWith('/channels/')) ui.remember(serverId.value, ch.id)
  if (liveRoute.value.path !== want) void navigateTo(want, { replace: true })
}, { immediate: true })

const typingNames = computed(() => presence.typingIn(channelId.value)
  .filter((id) => id !== session.user?.id)
  .map((id) => {
    const member = members.value.find(m => m.user.id === id)
    return member?.nickname || member?.user.displayName
      || channel.value?.participants?.find(u => u.id === id)?.displayName || 'Someone'
  }))
const agentBusy = computed(() => presence.agentTurnsIn(channelId.value).length > 0)
const canApproveAgent = computed(() => can(Permission.approveAgentActions))

function onReply(id: string) {
  ui.startReply(channelId.value, id)
}

// Files dropped anywhere on the conversation attach to the message being written.
const composer = ref<{ addFiles: (files: File[]) => void } | null>(null)
const dragDepth = ref(0)
const dropping = computed(() => dragDepth.value > 0)
function hasFiles(event: DragEvent) {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files')
}
function onDragEnter(event: DragEvent) {
  if (!hasFiles(event) || !canAttachFiles.value || !canSendMessages.value) return
  event.preventDefault()
  dragDepth.value += 1
}
function onDragOver(event: DragEvent) {
  if (!hasFiles(event) || !dropping.value) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
}
function onDragLeave(event: DragEvent) {
  if (!hasFiles(event) || !dropping.value) return
  dragDepth.value = Math.max(0, dragDepth.value - 1)
}
function onDrop(event: DragEvent) {
  if (!dropping.value) return
  event.preventDefault()
  dragDepth.value = 0
  composer.value?.addFiles(Array.from(event.dataTransfer?.files ?? []))
}

function linkThreadToMessage(messageId: string, threadId: string) {
  qc.setQueryData<InfiniteData<{ messages: MessageDTO[]; nextCursor: string | null }>>(
    ['messages', channelId.value],
    data => data
      ? {
          ...data,
          pages: data.pages.map(page => ({
            ...page,
            messages: page.messages.map(message => message.id === messageId ? { ...message, threadId } : message),
          })),
        }
      : data,
  )
}

async function onThread(msg: MessageDTO) {
  ui.rightPanelOpen = true
  ui.rightPanelTab = 'threads'
  ui.threadParentId = channelId.value
  if (msg.threadId) {
    qc.setQueryData<InfiniteData<{ messages: MessageDTO[]; nextCursor: string | null; rootMessage?: MessageDTO | null }>>(
      ['messages', msg.threadId], data => data ? {
        ...data,
        pages: data.pages.map((page, index) => index === 0 ? { ...page, rootMessage: msg } : page),
      } : data,
    )
    ui.threadId = msg.threadId
    return
  }
  // Open the panel at once; creating the thread is a network round trip.
  const pendingId = `${PENDING_THREAD_PREFIX}${msg.id}`
  ui.pendingThreadTitle = threadTitle(msg.content, msg.attachments.map(item => item.filename), Object.fromEntries(members.value.map(member => [member.user.id, member.nickname || member.user.displayName])))
  ui.threadId = pendingId
  let res: { channel: { id: string }, created?: boolean }
  try {
    res = await api(`/api/channels/${channelId.value}/threads`, {
      method: 'POST',
      body: { messageId: msg.id },
    })
  }
  catch (error) {
    if (ui.threadId === pendingId) ui.threadId = null
    toast.add({ title: errorMessage(error), color: 'error' })
    return
  }
  // A thread created just now has no messages, so there is nothing to fetch.
  if (res.created) {
    qc.setQueryData(['messages', res.channel.id], {
      pages: [{ messages: [], rootMessage: { ...msg, threadId: res.channel.id }, nextCursor: null, lastReadMessageId: null }],
      pageParams: [undefined],
    })
  }
  linkThreadToMessage(msg.id, res.channel.id)
  if (ui.threadId === pendingId) ui.threadId = res.channel.id
  void qc.invalidateQueries({ queryKey: ['threads', channelId.value] })
  void qc.invalidateQueries({ queryKey: ['channels'] })
  void qc.invalidateQueries({ queryKey: ['dms'] })
}

const privateMembersOpen = ref(false)
watch(channelId, () => { privateMembersOpen.value = false })
const liveMembers = computed<MemberDTO[]>(() => {
  if (!isDm.value) return members.value
  return (channel.value?.participants ?? []).map((u) => ({
    user: u,
    role: { id: '', serverId: serverId.value, key: 'member', name: 'member', permissions: 0, position: 0, isSystem: true },
    nickname: null,
    status: presence.statusOf(u.id),
  }))
})

defineShortcuts({
  escape: () => {
    ui.searchOpen = false
    ui.liveSetupOpen = false
    ui.cancelComposerIntent(channelId.value)
    if (ui.threadId) ui.cancelComposerIntent(ui.threadId)
  },
})
</script>

<template>
  <SettingsPrivateChannelMembers v-if="channel && !isDm && channel.visibility === 'private'" v-model:open="privateMembersOpen" :server-id="serverId" :channel="channel" />
  <div class="relative flex-1 min-h-0 h-full flex bg-default">
    <div
      class="relative flex-1 min-w-0 flex flex-col min-h-0"
      @dragenter="onDragEnter"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
    >
      <div
        v-if="dropping"
        class="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-default/80 p-6 backdrop-blur-sm"
      >
        <div class="flex w-full max-w-sm flex-col items-center gap-2 rounded-xl border-2 border-dashed border-primary bg-elevated px-6 py-8 text-center">
          <UIcon name="i-ph-upload-simple" class="size-10 text-primary" />
          <p class="text-lg font-semibold text-highlighted">Upload to {{ isDm ? headerName : `#${headerName}` }}</p>
          <p class="text-sm text-muted">Drop files to attach them to your message.</p>
        </div>
      </div>
      <header class="@container relative h-12 ps-3 pe-2 md:ps-4 flex items-center gap-2 shadow-[0_1px_0_var(--ui-border)] shrink-0 z-10 bg-default">
        <LayoutMobileMenuButton />
        <UIcon v-if="!isDm" name="i-ph-hash" class="size-5 text-muted shrink-0" />
        <UserAvatar v-else-if="others[0]" :user="others[0]" size="2xs" />
        <UAvatar v-else-if="channel" size="2xs" :text="headerName.slice(0, 1).toUpperCase()" />
        <USkeleton v-if="!channel" class="h-4 w-32" />
        <h1 v-if="channel" class="min-w-12 font-semibold text-[16px] truncate text-highlighted">{{ headerName }}</h1>
        <UChip
          v-if="isDm && others[0]?.kind === 'human'"
          :color="presence.statusOf(others[0].id) === 'online' ? 'success' : 'neutral'"
          :title="`${others[0].displayName}: ${presence.statusOf(others[0].id)}`"
          :aria-label="`${others[0].displayName}: ${presence.statusOf(others[0].id)}`"
          size="sm"
          standalone
        />
        <USeparator v-if="!isDm && channel?.topic" orientation="vertical" class="h-4" />
        <p v-if="!isDm" class="text-sm text-muted truncate hidden lg:block min-w-0 flex-1">{{ channel?.topic }}</p>
        <div class="ml-auto flex items-center gap-2">
          <UTooltip v-if="showConnection && connection === 'offline'" text="You're offline. New messages will appear when you reconnect.">
            <span class="flex size-7 items-center justify-center text-muted" role="status" aria-label="Offline">
              <UIcon name="i-ph-wifi-slash" class="size-4" />
            </span>
          </UTooltip>
          <!-- The header's own width decides, not the window's: with both side panels open the column can be narrow on a wide screen. -->
          <UButton
            class="@xl:hidden"
            icon="i-ph-magnifying-glass"
            color="neutral"
            variant="ghost"
            size="sm"
            square
            aria-label="Search messages"
            @click="ui.searchOpen = true"
          />
          <button
            type="button"
            class="hidden @xl:flex w-40 h-8 items-center gap-2 rounded-md bg-muted px-2 text-xs text-muted hover:text-default"
            aria-label="Search messages"
            @click="ui.searchOpen = true"
          >
            <UIcon name="i-ph-magnifying-glass" class="size-3.5" />
            <span class="flex-1 text-start">Search</span>
            <kbd class="inline-flex h-5 items-center rounded border border-default bg-default/40 px-1.5 font-sans text-[11px] text-toned">⌘ K</kbd>
          </button>
          <UTooltip
            v-if="isConversation && !directAgentId"
            :text="liveActionHint"
          >
            <UButton
              :icon="liveKind === 'call' ? 'i-ph-phone' : 'i-ph-waveform'"
              color="neutral"
              :variant="roomActive ? 'soft' : 'ghost'"
              size="sm"
              square
              :disabled="callsUnavailable || (!roomActive && !canStartLive)"
              :aria-label="liveActionLabel"
              @click="openPrejoin()"
            />
          </UTooltip>
          <UTooltip v-if="!isDm && type === 'text' && channel?.visibility === 'private' && channel.createdBy === session.user?.id && channelsQ.data.value?.channels.some(item => item.id === channelId)" text="Manage channel members">
            <UButton color="neutral" variant="ghost" size="sm" square icon="i-ph-users" aria-label="Manage channel members" @click="privateMembersOpen = true" />
          </UTooltip>
          <UTooltip :text="ui.rightPanelOpen ? 'Close right panel' : 'Open right panel'">
            <UButton
              :icon="ui.rightPanelOpen ? 'i-ph-sidebar-simple-fill' : 'i-ph-sidebar-simple'"
              color="neutral"
              :variant="ui.rightPanelOpen ? 'soft' : 'ghost'"
              size="sm"
              square
              class="hidden lg:inline-flex"
              :aria-label="ui.rightPanelOpen ? 'Close right panel' : 'Open right panel'"
              :aria-pressed="ui.rightPanelOpen"
              @click="ui.rightPanelOpen = !ui.rightPanelOpen"
            />
          </UTooltip>
          <UButton
            class="size-11 shrink-0 lg:hidden"
            icon="i-ph-sidebar-simple"
            color="neutral"
            variant="ghost"
            size="md"
            square
            aria-label="Open channel details"
            aria-controls="channel-details"
            :aria-expanded="ui.mobilePane === 'members'"
            @click="ui.mobilePane = 'members'"
          />
        </div>
        <LayoutActivityBar v-if="showConnection && connection !== 'connected' && connection !== 'offline'" label="Reconnecting to live updates" />
      </header>

      <LiveStage
        v-if="showStage"
        :can-end="canEndLive"
        :can-moderate="isLiveHost"
        @leave="leave"
        @end="endLive"
      />
      <ChatMessageList
        v-else
        :channel-id="channelId"
        :members="members"
        :channel-name="headerName"
        :is-dm="isDm"
        :can-pin="canPin"
        :can-moderate="canModerate"
        :can-create-tasks="canCreateTasks"
        :link-path="channel ? channelPath(channel) : undefined"
        @reply="onReply"
        @thread="onThread"
        @read="(messageId) => send({ t: 'read', messageId })"
        @retry="retry"
      />
      <UAlert v-if="frozen" color="neutral" variant="subtle" title="You can no longer send messages to this user." class="rounded-none shrink-0" />
      <ChatAgentActivity
        :channel-id="channelId"
        :members="members"
        :send="send"
        :can-approve="canApproveAgent"
      />
      <LiveBar
        v-if="isConversation && (live.state?.active || joinedHere)"
        :channel-id="channelId"
        :members="liveMembers"
        @join="openPrejoin()"
      />
      <div class="relative shrink-0">
        <ChatComposer
          ref="composer"
          :channel-id="channelId"
          :server-id="serverId"
          :members="members"
          :send="send"
          :disabled="!permissionsKnown || !canSendMessages"
          :disabled-placeholder="composerDisabledPlaceholder"
          :can-attach="canAttachFiles"
          :agent-busy="agentBusy"
          :agent-id="directAgentId"
          :placeholder="composerPlaceholder"
          primary
        />
        <!-- In the composer's bottom padding, so it never pushes the layout. -->
        <p
          v-if="typingNames.length && !agentBusy"
          class="pointer-events-none absolute bottom-1 start-4 flex items-center gap-1.5 text-xs text-toned"
          aria-live="polite"
        >
          <span class="typing-dots" aria-hidden="true"><i /><i /><i /></span>
          <span v-if="typingNames.length > 3" class="truncate">Several people are typing…</span>
          <span v-else class="truncate">
            <template v-for="(name, index) in typingNames" :key="name + index">
              <template v-if="index">{{ index === typingNames.length - 1 ? ' and ' : ', ' }}</template><strong>{{ name }}</strong>
            </template>
            {{ typingNames.length === 1 ? ' is typing…' : ' are typing…' }}
          </span>
        </p>
      </div>
    </div>
    <Transition name="right-panel" :css="isMobile">
      <ChatThreadPanel
        v-if="ui.rightPanelOpen && ui.rightPanelTab === 'threads' && ui.threadId"
        key="thread"
        :agent-id="directAgentId"
        :server-id="serverId"
        :members="members"
        :can-pin="canPin"
        :can-moderate="canModerate"
        :can-create-tasks="canCreateTasks"
      />
      <LayoutMemberRail
        v-else-if="(!detailsOverlay && ui.rightPanelOpen) || (detailsOverlay && ui.mobilePane === 'members')"
        key="details"
        :overlay="detailsOverlay"
        :server-id="serverId"
        :channel-id="channelId"
        :channel-members="isDm ? channel?.participants : undefined"
        :is-group-dm="false"
        :can-pin="canPin"
      />
    </Transition>
    <LivePrejoinModal
      v-model:open="prejoinOpen"
      :title="headerName"
      :kind="liveKind"
      :action="roomActive ? 'join' : 'start'"
      @confirm="confirmPrejoin"
    />
    <LiveSetupModal />
  </div>
</template>

<style scoped>
.right-panel-enter-active {
  transition: transform 220ms cubic-bezier(0.32, 0.72, 0, 1);
}

.right-panel-leave-active {
  transition: transform 180ms ease-in;
}

.right-panel-enter-from,
.right-panel-leave-to {
  transform: translateX(100%);
}

.typing-dots {
  display: inline-flex;
  gap: 2px;
}

.typing-dots i {
  width: 4px;
  height: 4px;
  border-radius: 9999px;
  background: currentColor;
  animation: typing-dot 1.2s infinite ease-in-out;
}

.typing-dots i:nth-child(2) { animation-delay: 0.15s; }
.typing-dots i:nth-child(3) { animation-delay: 0.3s; }

@keyframes typing-dot {
  0%, 60%, 100% { opacity: 0.35; transform: translateY(0); }
  30% { opacity: 1; transform: translateY(-2px); }
}

@media (prefers-reduced-motion: reduce) {
  .typing-dots i { animation: none; }
  .right-panel-enter-active,
  .right-panel-leave-active {
    transition-duration: 1ms;
  }
}
</style>
