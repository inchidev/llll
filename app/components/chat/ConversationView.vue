<script setup lang="ts">
import { useQuery, useQueryClient, type InfiniteData } from '@tanstack/vue-query'
import { onKeyStroke } from '@vueuse/core'
import type { ChannelDTO, MemberDTO, MessageDTO, PublicUser } from '~~/shared/types'
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
const isGroup = computed(() => isDm.value && (channel.value?.participants?.length ?? 0) > 2)
const others = computed(() => (channel.value?.participants ?? []).filter((p) => p.id !== session.user?.id))
const headerName = computed(() => {
  if (!isDm.value) return channel.value?.name || ''
  return channel.value?.title || dmTitle(channel.value?.name, channel.value?.participants ?? [], session.user?.id || '')
})
const frozen = computed(() => Boolean(oneQ.data.value?.frozen || channel.value?.frozen || ui.dmFrozen))
const { can, mine } = usePermissions(members)
const canPin = computed(() => isDm.value ? !frozen.value : can(Permission.manageChannels))
const effectivePermissions = computed(() => channel.value?.permissions ?? mine.value?.role.permissions ?? 0)
const canSendMessages = computed(() => isDm.value ? !frozen.value : hasPermission(effectivePermissions.value, Permission.sendMessages))
const canAttachFiles = computed(() => session.health?.bindings.r2 !== false && (isDm.value ? !frozen.value : hasPermission(effectivePermissions.value, Permission.attachFiles)))
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
const pairDm = computed(() => isDm.value && !isGroup.value)
const roomActive = computed(() => Boolean(live.state?.active))
const liveKind = computed(() => roomActive.value ? live.state!.kind : liveKindFor(pairDm.value))
const liveActionLabel = computed(() => roomActive.value ? liveJoinLabel(liveKind.value) : liveStartLabel(liveKind.value))
const callsUnavailable = computed(() => session.health?.capabilities.calls === false)
const liveActionHint = computed(() => {
  if (callsUnavailable.value) return 'Calls use Cloudflare RealtimeKit and are unavailable on this runtime.'
  if (roomActive.value || canStartLive.value) return liveActionLabel.value
  return frozen.value ? 'You can no longer call in this Direct Message' : 'Your role cannot start live sessions here'
})
const joinedHere = computed(() => live.connection === 'connected' && live.currentChannelId === channelId.value)
const showStage = computed(() => joinedHere.value && live.expanded)
// Mirrors the server's host rule: the starter, or someone who manages this Channel.
const canEndLive = computed(() => Boolean(
  live.state?.active
  && (live.state.startedBy === session.user?.id
    || (!isDm.value && hasPermission(effectivePermissions.value, Permission.manageChannels))),
))

function openPrejoin() {
  live.error = null
  if (callsUnavailable.value) return
  // Say Live is not connected before asking for a camera and microphone.
  if (session.health && !session.health.realtimekit) {
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
  ui.remember(serverId.value, channelId.value)
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
  if (liveRoute.value.path !== want) void navigateTo(want, { replace: true })
})

const typingNames = computed(() => presence.typingIn(channelId.value)
  .filter((id) => id !== session.user?.id)
  .map((id) => {
    const member = members.value.find(m => m.user.id === id)
    return member?.nickname || member?.user.displayName
      || channel.value?.participants?.find(u => u.id === id)?.displayName || 'Someone'
  }))
const agentBusy = computed(() => presence.agentTurnsIn(channelId.value).length > 0)
const canApproveAgent = computed(() => can(Permission.manageServer))

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
    ui.threadId = msg.threadId
    return
  }
  // Open the panel at once; creating the thread is a network round trip.
  const pendingId = `${PENDING_THREAD_PREFIX}${msg.id}`
  ui.pendingThreadTitle = threadTitle(msg.content, msg.attachments.map(item => item.filename))
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
      pages: [{ messages: [], nextCursor: null, lastReadMessageId: null }],
      pageParams: [undefined],
    })
  }
  linkThreadToMessage(msg.id, res.channel.id)
  if (ui.threadId === pendingId) ui.threadId = res.channel.id
  void qc.invalidateQueries({ queryKey: ['threads', channelId.value] })
}

const addOpen = ref(false)
const addQ = ref('')
const addSearch = useQuery({
  queryKey: computed(() => ['dm-add', serverId.value, addQ.value]),
  queryFn: () => api<{ members: PublicUser[] }>(`/api/dms/search?serverId=${serverId.value}&q=${encodeURIComponent(addQ.value)}`),
  enabled: computed(() => addOpen.value),
})

async function addPerson(userId: string) {
  await api(`/api/dms/${channelId.value}/participants`, { method: 'POST', body: { userId } })
  await qc.invalidateQueries({ queryKey: ['dms'] })
  await qc.invalidateQueries({ queryKey: ['channel', channelId.value] })
  addOpen.value = false
}

const renaming = ref(false)
const rename = ref('')
watch(headerName, (n) => { if (!renaming.value) rename.value = n }, { immediate: true })

async function saveName() {
  await api(`/api/dms/${channelId.value}`, { method: 'PATCH', body: { name: rename.value.trim() || null } })
  renaming.value = false
  await qc.invalidateQueries({ queryKey: ['dms'] })
  await qc.invalidateQueries({ queryKey: ['channel', channelId.value] })
}

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
    renaming.value = false
    addOpen.value = false
  },
})
</script>

<template>
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
        <UserAvatar v-else-if="!isGroup && others[0]" :user="others[0]" size="2xs" />
        <UAvatar v-else-if="channel" size="2xs" :text="(others[0]?.displayName || headerName).slice(0, 1).toUpperCase()" />
        <USkeleton v-if="!channel" class="h-4 w-32" />
        <UInput
          v-if="isGroup && renaming"
          v-model="rename"
          size="sm"
          class="max-w-xs"
          autofocus
          @keyup.enter="saveName"
          @keyup.escape="renaming = false"
        />
        <h1
          v-else-if="channel"
          class="min-w-12 font-semibold text-[16px] truncate text-highlighted"
          :class="isGroup ? 'cursor-text' : ''"
          @dblclick="isGroup && (renaming = true)"
        >{{ headerName }}</h1>
        <UChip v-if="isDm && others[0] && !isGroup" :color="presence.statusOf(others[0].id) === 'online' ? 'success' : 'neutral'" size="sm" standalone />
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
            <kbd class="inline-flex h-5 items-center rounded border border-default bg-default/40 px-1.5 font-sans text-[10px] text-toned">⌘ K</kbd>
          </button>
          <UTooltip
            v-if="isConversation"
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
          <UTooltip v-if="isDm" text="Add friends to DM">
            <UButton color="neutral" variant="ghost" size="sm" square icon="i-ph-user-plus" aria-label="Add people" @click="addOpen = !addOpen" />
          </UTooltip>
          <UTooltip :text="ui.rightPanelOpen ? 'Close right panel' : 'Open right panel'">
            <UButton
              :icon="ui.rightPanelOpen ? 'i-ph-sidebar-simple-fill' : 'i-ph-sidebar-simple'"
              color="neutral"
              :variant="ui.rightPanelOpen ? 'soft' : 'ghost'"
              size="sm"
              square
              class="hidden md:inline-flex"
              :aria-label="ui.rightPanelOpen ? 'Close right panel' : 'Open right panel'"
              :aria-pressed="ui.rightPanelOpen"
              @click="ui.rightPanelOpen = !ui.rightPanelOpen"
            />
          </UTooltip>
          <UButton
            class="size-11 shrink-0 md:hidden"
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
      <div v-if="addOpen" class="border-b border-default p-2 shrink-0">
        <UInput v-model="addQ" size="sm" icon="i-ph-magnifying-glass" placeholder="Add people" />
        <UButton
          v-for="m in addSearch.data.value?.members ?? []"
          :key="m.id"
          variant="ghost"
          color="neutral"
          size="sm"
          block
          class="justify-start"
          :label="m.displayName"
          @click="addPerson(m.id)"
        />
      </div>
      <LiveStage
        v-if="showStage"
        :can-end="canEndLive"
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
        :link-path="channelPath(channelId)"
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
        :server-id="serverId"
        :members="members"
        :can-pin="canPin"
      />
      <LayoutMemberRail
        v-else-if="(!isMobile && ui.rightPanelOpen) || (isMobile && ui.mobilePane === 'members')"
        key="details"
        :server-id="serverId"
        :channel-id="channelId"
        :channel-members="isDm ? channel?.participants : undefined"
        :is-group-dm="isGroup"
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
