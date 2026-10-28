<script setup lang="ts">
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/vue-query'
import type { InfiniteData } from '@tanstack/vue-query'
import type { ContextMenuItem, DropdownMenuItem } from '@nuxt/ui'
import type { ChannelThreadDTO, MemberDTO, MessageContextResponse, MessageDTO, MessagePinDTO, MessageSearchHitDTO, MessageSearchResponse, TaskSourceLinkDTO } from '~~/shared/types'
import { formatDayLabel, formatFullDateTime, formatMessageTime, sameDay } from '~~/shared/format'
import { applyMentionTokens, extractMentionIds, humanizeMentions } from '~~/shared/mentions'
import { replaceShortcodes } from '~~/shared/emoji'
import { channelPath } from '~~/shared/paths'
import { nowIso } from '~~/shared/ids'
import { mergeMessageContext, type MessagePage } from '~/utils/message-cache'
import { applyReactionChange } from '~/utils/message-reactions'
import { useVirtualizer } from '@tanstack/vue-virtual'
import type { ComponentPublicInstance } from 'vue'

const props = withDefaults(defineProps<{
  channelId: string
  members: MemberDTO[]
  channelName?: string
  isDm?: boolean
  canPin?: boolean
  /** Manage channels here: delete other people's messages. */
  canModerate?: boolean
  showIntro?: boolean
  /** Threads cannot hold threads of their own. */
  allowThreads?: boolean
  /** The app path a copied message link opens, before `?message=`. */
  linkPath?: string
  /** Offer Create task on messages (Create and update tasks somewhere in the Server). */
  canCreateTasks?: boolean
  /** An archived conversation: history only. Existing threads still open; nothing new is added. */
  readOnly?: boolean
}>(), { channelName: undefined, linkPath: undefined, showIntro: true, allowThreads: true })
const { api } = useApi()
const emit = defineEmits<{
  reply: [id: string]
  thread: [msg: MessageDTO]
  read: [messageId: string]
  retry: [clientId: string]
  rootMessage: [message: MessageDTO | null]
}>()

const session = useSessionStore()
const presence = usePresenceStore()
const ui = useUiStore()
const prefs = usePrefsStore()
const toast = useToast()
const qc = useQueryClient()
const route = useRouter().currentRoute
const scroller = ref<HTMLElement | null>(null)
const content = ref<HTMLElement | null>(null)
const highlightId = ref<string | null>(null)
const jumpingToId = ref<string | null>(null)
const unreadBoundary = ref<string | null>(null)
const activeId = ref<string | null>(null)
let lastRead = ''

type MessageResponse = MessagePage & {
  lastReadMessageId?: string | null
}

const messagesKey = computed(() => ['messages', props.channelId] as const)

/** Tasks created from messages here, shown under their message. Only Tasks the viewer can read are returned. */
const taskLinksQ = useQuery({
  queryKey: computed(() => ['task-links', props.channelId]),
  queryFn: () => api<{ links: TaskSourceLinkDTO[] }>(`/api/channels/${props.channelId}/task-links`),
  staleTime: 60_000,
})
const taskLinksByMessage = computed(() => {
  const map = new Map<string, TaskSourceLinkDTO[]>()
  for (const link of taskLinksQ.data.value?.links ?? []) map.set(link.messageId, [...(map.get(link.messageId) ?? []), link])
  return map
})

const q = useInfiniteQuery({
  queryKey: messagesKey,
  initialPageParam: undefined as string | undefined,
  queryFn: ({ pageParam }) => api<MessageResponse>(`/api/channels/${props.channelId}/messages`, {
    query: { cursor: pageParam, limit: 50 },
  }),
  getNextPageParam: (last) => last.nextCursor ?? undefined,
})

// The "New" divider comes from the read cursor in the first fresh page. Cached
// pages from an earlier visit carry an old cursor, so wait for them to refresh.
let boundarySettled = false
watchEffect(() => {
  const page = q.data.value?.pages[0] as MessageResponse | undefined
  if (boundarySettled || !page || q.isFetching.value || q.isStale.value) return
  boundarySettled = true
  if (!('lastReadMessageId' in page)) return
  const lastReadId = page.lastReadMessageId
  const firstUnread = page.messages.find(message => !message.id.startsWith('tmp:')
    && message.author.id !== session.user?.id
    && (!lastReadId || message.id > lastReadId))
  unreadBoundary.value = firstUnread && lastReadId ? firstUnread.id : null
})

// Discord removes deleted messages; one that started a thread stays as a placeholder.
const rootMessage = computed(() => q.data.value?.pages[0]?.rootMessage ?? null)
watch(rootMessage, message => emit('rootMessage', message), { immediate: true })
const messages = computed(() => {
  const pages = q.data.value?.pages ?? []
  const replies = [...pages].reverse().flatMap((p) => p.messages).filter(message => !message.deletedAt || message.threadId)
  // Show the original at the beginning of the full thread, after older replies load.
  return rootMessage.value && !q.hasNextPage.value ? [rootMessage.value, ...replies] : replies
})
const contentMargin = ref(0)
const virtualizer = useVirtualizer(computed(() => ({
  count: messages.value.length,
  getScrollElement: () => scroller.value,
  getItemKey: (index: number) => messages.value[index]!.id,
  estimateSize: () => 84,
  overscan: 8,
  scrollMargin: contentMargin.value,
})))
const virtualRows = computed(() => virtualizer.value.getVirtualItems().map(item => ({ ...item, message: messages.value[item.index]! })))
function measureRow(element: Element | ComponentPublicInstance | null) {
  if (element instanceof HTMLElement) virtualizer.value.measureElement(element)
}
function measureContentMargin() {
  if (content.value && scroller.value) contentMargin.value = content.value.getBoundingClientRect().top - scroller.value.getBoundingClientRect().top + scroller.value.scrollTop
}
const streamingMessageIds = computed(() => new Set(
  presence.agentTurnsIn(props.channelId).map(turn => turn.draftMessageId).filter((id): id is string => Boolean(id)),
))
const threadsQ = useQuery({
  queryKey: computed(() => ['threads', props.channelId]),
  queryFn: () => api<{ threads: ChannelThreadDTO[] }>(`/api/channels/${props.channelId}/threads`),
  enabled: computed(() => props.allowThreads && messages.value.some(message => Boolean(message.threadId))),
})
const threadsByMessage = computed(() => new Map(
  (threadsQ.data.value?.threads ?? []).map(thread => [thread.parentMessageId, thread]),
))

const ownsSearch = computed(() => !ui.threadId || ui.threadId === props.channelId)
const requestedSearchTerm = computed(() => ui.searchQuery.trim())
const searchTerm = refDebounced(computed(() => ui.searchQuery.trim()), 250)
const searchSettled = computed(() => searchTerm.value === requestedSearchTerm.value)
const hasSearchableTerm = computed(() => /[\p{L}\p{N}]/u.test(requestedSearchTerm.value))
const searchReady = computed(() => ownsSearch.value
  && ui.searchOpen
  && searchSettled.value
  && hasSearchableTerm.value)

const { serverId } = useServer()
const serverSearch = computed(() => ui.searchScope === 'server' && Boolean(serverId.value))
const searchScopes = [
  { label: 'This conversation', value: 'conversation' },
  { label: 'Whole server', value: 'server' },
]
const searchQ = useInfiniteQuery({
  // Server-wide results span conversations whose access can change, so they are never cached.
  queryKey: computed(() => serverSearch.value
    ? ['message-search', 'server', serverId.value, searchTerm.value]
    : ['message-search', props.channelId, searchTerm.value]),
  initialPageParam: undefined as string | undefined,
  queryFn: ({ pageParam }) => api<MessageSearchResponse>(serverSearch.value
    ? `/api/servers/${serverId.value}/search`
    : `/api/channels/${props.channelId}/search`, {
    query: { q: searchTerm.value, cursor: pageParam, limit: 20 },
  }),
  getNextPageParam: last => last.nextCursor ?? undefined,
  gcTime: computed(() => serverSearch.value ? 0 : 5 * 60 * 1000),
  enabled: searchReady,
})

const searchResults = computed(() => searchReady.value
  ? searchQ.data.value?.pages.flatMap(page => page.hits) ?? []
  : [])
const searchLoading = computed(() => Boolean(
  requestedSearchTerm.value
  && hasSearchableTerm.value
  && (!searchSettled.value || (searchReady.value && searchQ.isPending.value)),
))
const searchEmpty = computed(() => Boolean(
  requestedSearchTerm.value
  && searchSettled.value
  && (!hasSearchableTerm.value || (searchReady.value && !searchQ.isPending.value && !searchQ.error.value && !searchResults.value.length)),
))

const names = computed(() => {
  const map: Record<string, string> = {}
  for (const m of props.members) map[m.user.id] = m.nickname || m.user.displayName
  return map
})
const membersById = computed(() => new Map(props.members.map(member => [member.user.id, member])))
const mentionables = computed(() => props.members.map(m => ({ id: m.user.id, displayName: m.user.displayName, nickname: m.nickname })))
const editingId = computed(() => ui.composerState(props.channelId).editingId)

function compactWith(curr: MessageDTO, prev?: MessageDTO) {
  if (!prev || curr.replyTo) return false
  if (prev.author.id !== curr.author.id) return false
  if (prev.deletedAt) return false
  if (!sameDay(curr.createdAt, prev.createdAt)) return false
  const dt = Math.abs(new Date(curr.createdAt).getTime() - new Date(prev.createdAt).getTime())
  return dt < 7 * 60 * 1000
}

function mentionsMe(message: MessageDTO) {
  const me = session.user?.id
  if (!me || message.author.id === me) return false
  return message.mentions.includes(me) || message.replyTo?.authorId === me
}

/* ------------------------------------------------------------------ scrolling */

const BOTTOM_SLACK = 120
// Pinned while the reader is at the newest message: growing content (images,
// embeds, edits) then keeps them there instead of pushing the bottom away.
const pinned = ref(true)
const unseen = ref(0)

function distanceFromBottom() {
  const el = scroller.value
  return el ? el.scrollHeight - el.scrollTop - el.clientHeight : 0
}

function scrollToBottom(smooth = false) {
  const el = scroller.value
  if (!el) return
  if (messages.value.length) virtualizer.value.scrollToEnd({ behavior: smooth ? 'smooth' : 'auto' })
  else el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  pinned.value = true
  unseen.value = 0
}

function markReadIfVisible() {
  const message = messages.value.at(-1)
  if (!scroller.value || !message || message.channelId !== props.channelId || ui.searchOpen || document.hidden || !document.hasFocus()) return
  if (distanceFromBottom() > BOTTOM_SLACK || message.id === lastRead || message.id.startsWith('tmp:')) return
  lastRead = message.id
  emit('read', message.id)
}

watch(() => messages.value.at(-1)?.id, async (id, previous) => {
  const last = messages.value.at(-1)
  const sentByMe = Boolean(last && last.author.id === session.user?.id && last.id.startsWith('tmp:'))
  await nextTick()
  if (pinned.value || sentByMe) scrollToBottom()
  else if (id && previous && last && last.author.id !== session.user?.id) unseen.value += 1
  markReadIfVisible()
})

let loadingOlder = false
function onScroll() {
  const el = scroller.value
  if (!el) return
  pinned.value = distanceFromBottom() <= BOTTOM_SLACK
  if (pinned.value) unseen.value = 0
  if (el.scrollTop < 400 && q.hasNextPage.value && !q.isFetchingNextPage.value && !loadingOlder) void loadOlder()
  markReadIfVisible()
}

async function loadOlder() {
  const el = scroller.value
  if (!el) return
  loadingOlder = true
  const previousHeight = el.scrollHeight
  const previousTop = el.scrollTop
  const top = el.getBoundingClientRect().top
  const anchor = [...el.querySelectorAll<HTMLElement>('[data-message-id]')].find(row => row.getBoundingClientRect().bottom > top)
  const anchorId = anchor?.dataset.messageId
  const anchorOffset = anchor ? anchor.getBoundingClientRect().top - top : 0
  try {
    await q.fetchNextPage()
    await nextTick()
    if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight - previousHeight + previousTop
    // Finish row measurements and removal of the loading indicator before
    // correcting the visible message's position. Total height alone is estimated.
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    if (scroller.value && anchorId) {
      const row = scroller.value.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(anchorId)}"]`)
      if (row) virtualizer.value.scrollToOffset(scroller.value.scrollTop + row.getBoundingClientRect().top - scroller.value.getBoundingClientRect().top - anchorOffset)
    }
  }
  finally {
    loadingOlder = false
  }
}

let resizeObserver: ResizeObserver | undefined

watch(content, (element) => {
  resizeObserver?.disconnect()
  if (!element || typeof ResizeObserver === 'undefined') return
  resizeObserver = new ResizeObserver(() => {
    measureContentMargin()
    if (pinned.value && !loadingOlder) scrollToBottom()
  })
  resizeObserver.observe(element)
  measureContentMargin()
  if (pinned.value) scrollToBottom()
}, { flush: 'post' })

onMounted(() => {
  nextTick(() => {
    measureContentMargin()
    scrollToBottom()
    markReadIfVisible()
  })
  window.addEventListener('focus', markReadIfVisible)
  document.addEventListener('visibilitychange', markReadIfVisible)
})

onUnmounted(() => {
  resizeObserver?.disconnect()
  window.removeEventListener('focus', markReadIfVisible)
  document.removeEventListener('visibilitychange', markReadIfVisible)
})

async function jumpToPresent() {
  if (q.data.value && !q.data.value.pages[0]?.messages.length) await q.refetch()
  await nextTick()
  scrollToBottom(true)
}

/* ------------------------------------------------------------------ actions */

// Deleting cannot be undone, so it asks first unless Shift was held.
const removeId = ref<string | null>(null)
const removing = ref(false)
async function deleteMessage(id: string) {
  await api(`/api/messages/${id}`, { method: 'DELETE' })
}
function remove(id: string, immediate = false) {
  if (!immediate) {
    removeId.value = id
    return
  }
  deleteMessage(id).catch(error => toast.add({ title: errorMessage(error), color: 'error' }))
}
async function confirmRemove() {
  const id = removeId.value
  if (!id) return
  removing.value = true
  try {
    await deleteMessage(id)
    removeId.value = null
  }
  catch (error) {
    toast.add({ title: errorMessage(error), color: 'error' })
  }
  finally {
    removing.value = false
  }
}

function patchMessage(id: string, patch: Partial<MessageDTO>) {
  qc.setQueryData<InfiniteData<MessagePage>>(messagesKey.value, (data) => {
    if (!data) return data
    return {
      ...data,
      pages: data.pages.map(page => ({
        ...page,
        messages: page.messages.map(item => item.id === id ? { ...item, ...patch } : item),
      })),
    }
  })
}

async function react(id: string, emoji: string) {
  if (id.startsWith('tmp:') || !session.user?.id) return
  const current = qc.getQueryData<InfiniteData<MessagePage>>(messagesKey.value)
  const message = current?.pages.flatMap(page => page.messages).find(item => item.id === id)
  if (!message) return
  const op = message.reactions.find(reaction => reaction.emoji === emoji)?.me ? 'remove' : 'add'
  const apply = (change: 'add' | 'remove') => {
    const latest = qc.getQueryData<InfiniteData<MessagePage>>(messagesKey.value)?.pages.flatMap(page => page.messages).find(item => item.id === id)
    if (latest) patchMessage(id, { reactions: applyReactionChange(latest.reactions, { emoji, userId: session.user!.id, op: change }, session.user!.id) })
  }
  apply(op)
  try {
    await api(`/api/messages/${id}/reactions`, { method: 'POST', body: { emoji } })
  }
  catch {
    apply(op === 'add' ? 'remove' : 'add')
    toast.add({ title: 'Could not update reaction', color: 'error' })
  }
}

async function togglePin(message: MessageDTO) {
  if (!props.canPin) return
  try {
    const response = await api<{ pin: MessagePinDTO | null }>(`/api/messages/${message.id}/pin`, {
      method: message.pin ? 'DELETE' : 'PUT',
    })
    patchMessage(message.id, { pin: response.pin })
    await qc.invalidateQueries({ queryKey: ['pins', props.channelId] })
    toast.add({ title: response.pin ? 'Message pinned' : 'Message unpinned', color: 'success' })
  }
  catch {
    toast.add({ title: message.pin ? 'Could not unpin message' : 'Could not pin message', color: 'error' })
  }
}

function startEdit(message: MessageDTO) {
  ui.startEditing(props.channelId, message.id, humanizeMentions(message.content, names.value))
}

async function saveEdit(message: MessageDTO) {
  const draft = ui.composerState(props.channelId).editDraft
  const content = replaceShortcodes(applyMentionTokens(draft, mentionables.value)).trim()
  if (!content && !message.attachments.length) {
    // An emptied message is a delete, as in Discord; ask first.
    ui.cancelEditing(props.channelId)
    remove(message.id)
    return
  }
  ui.cancelEditing(props.channelId)
  if (!content || content === message.content) return
  const previous = { content: message.content, editedAt: message.editedAt, mentions: message.mentions }
  patchMessage(message.id, { content, editedAt: nowIso(), mentions: extractMentionIds(content) })
  try {
    await api(`/api/messages/${message.id}`, { method: 'PATCH', body: { content } })
  }
  catch (error) {
    patchMessage(message.id, previous)
    ui.startEditing(props.channelId, message.id, draft)
    toast.add({ title: errorMessage(error), color: 'error' })
  }
}

function messageLink(message: MessageDTO) {
  const base = props.linkPath || channelPath(props.channelId)
  return `${window.location.origin}${base}?message=${message.id}`
}

async function copy(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.add({ title: `${label} copied`, color: 'success' })
  }
  catch {
    toast.add({ title: 'Could not copy', color: 'error' })
  }
}

const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🎉', '👀', '🔥', '✅', '🙏']
function quickReactions() {
  const recent = Array.isArray(prefs.recentEmoji) ? prefs.recentEmoji : []
  return [...new Set([...recent, ...QUICK_REACTIONS])].slice(0, 10)
}

/** Archived history keeps its existing threads open but adds no new ones or pins. */
const canPinHere = computed(() => props.canPin && !props.readOnly)
function canThread(message: MessageDTO) {
  return props.allowThreads && (!props.readOnly || Boolean(message.threadId))
}

function actionsFor(message: MessageDTO): DropdownMenuItem[][] {
  const mine = message.author.id === session.user?.id
  const main: DropdownMenuItem[] = props.readOnly ? [] : [
    {
      label: 'Add reaction',
      icon: 'i-ph-smiley-sticker',
      children: [quickReactions().map(emoji => ({ label: emoji, onSelect: () => { prefs.useEmoji(emoji); void react(message.id, emoji) } }))],
    },
  ]
  if (mine && !props.readOnly) main.push({ label: 'Edit message', icon: 'i-ph-pencil-simple', onSelect: () => startEdit(message) })
  if (!props.readOnly) main.push({ label: 'Reply', icon: 'i-ph-arrow-bend-up-left', onSelect: () => emit('reply', message.id) })
  if (canThread(message)) {
    main.push({ label: message.threadId ? 'Open thread' : 'Create thread', icon: 'i-ph-chats', onSelect: () => emit('thread', message) })
  }
  if (canPinHere.value) main.push({ label: message.pin ? 'Unpin message' : 'Pin message', icon: 'i-ph-push-pin', onSelect: () => { void togglePin(message) } })
  if (props.canCreateTasks && !message.deletedAt && !message.id.startsWith('tmp:')) {
    main.push({ label: 'Create task', icon: 'i-ph-kanban', onSelect: () => { void navigateTo({ path: '/tasks', query: { fromMessage: message.id } }) } })
  }
  const copyItems: DropdownMenuItem[] = []
  if (message.content.trim()) copyItems.push({ label: 'Copy text', icon: 'i-ph-copy', onSelect: () => { void copy(message.content, 'Text') } })
  copyItems.push({ label: 'Copy message link', icon: 'i-ph-link', onSelect: () => { void copy(messageLink(message), 'Link') } })
  copyItems.push({ label: 'Copy message ID', icon: 'i-ph-identification-badge', onSelect: () => { void copy(message.id, 'ID') } })
  const groups = [main, copyItems]
  if (mine || props.canModerate) groups.push([{ label: 'Delete message', icon: 'i-ph-trash', color: 'error', onSelect: () => remove(message.id) }])
  return groups
}

// One context menu serves every row; it is filled from the row right-clicked.
const contextMessage = ref<MessageDTO | null>(null)
const contextItems = computed<ContextMenuItem[][]>(() => contextMessage.value ? actionsFor(contextMessage.value) as ContextMenuItem[][] : [])

function messageFromEvent(event: Event): MessageDTO | null {
  const row = (event.target as Element | null)?.closest<HTMLElement>('[data-message-id]')
  const id = row?.dataset.messageId
  return id ? messages.value.find(message => message.id === id && message.channelId === props.channelId) ?? null : null
}

function onContextMenu(event: MouseEvent) {
  const message = messageFromEvent(event)
  const target = event.target as Element | null
  const selection = window.getSelection()?.toString()
  // Links, media, selected text, editors, and touch screens keep the browser's menu.
  if (!message || message.deletedAt || message.id.startsWith('tmp:') || editingId.value === message.id
    || target?.closest('a, img, video, audio, input, textarea') || selection
    || window.matchMedia('(pointer: coarse)').matches) {
    event.stopPropagation()
    return
  }
  contextMessage.value = message
}

// Phones get the same actions in a bottom sheet after a long press.
const sheetMessage = ref<MessageDTO | null>(null)
const sheetOpen = computed({
  get: () => Boolean(sheetMessage.value),
  set: (open) => { if (!open) sheetMessage.value = null },
})
const sheetActions = computed(() => sheetMessage.value
  ? actionsFor(sheetMessage.value).map(group => group.filter(item => !item.children))
  : [])

function runSheet(item: DropdownMenuItem) {
  sheetMessage.value = null
  item.onSelect?.(new Event('select'))
}

function reactFromSheet(emoji: string) {
  const message = sheetMessage.value
  sheetMessage.value = null
  if (!message) return
  prefs.useEmoji(emoji)
  void react(message.id, emoji)
}

/* ------------------------------------------------------------------ keyboard */

function onPointerOver(event: PointerEvent) {
  if (event.pointerType === 'touch') return
  const row = (event.target as Element | null)?.closest<HTMLElement>('[data-message-id]')
  activeId.value = row?.dataset.messageId ?? null
}

function onFocusIn(event: FocusEvent) {
  const row = (event.target as Element | null)?.closest<HTMLElement>('[data-message-id]')
  if (row) activeId.value = row.dataset.messageId ?? null
}

async function focusRow(id: string | undefined) {
  if (!id) return
  const index = messages.value.findIndex(message => message.id === id)
  if (index >= 0) virtualizer.value.scrollToIndex(index, { align: 'auto' })
  await nextTick()
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  const row = content.value?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`)
  row?.focus({ preventScroll: true })
  row?.scrollIntoView({ block: 'nearest' })
}

// With a message focused: arrows move between messages; E, R, T, P act on it.
function onRowKey(event: KeyboardEvent) {
  const target = event.target as HTMLElement
  if (!target.matches('[data-message-id]') || event.metaKey || event.ctrlKey || event.altKey) return
  const index = messages.value.findIndex(message => message.id === target.dataset.messageId)
  const message = messages.value[index]
  if (!message) return
  const mine = message.author.id === session.user?.id
  const key = event.key.toLowerCase()
  if (key === 'arrowup' || key === 'arrowdown') {
    event.preventDefault()
    focusRow(messages.value[index + (key === 'arrowup' ? -1 : 1)]?.id)
  }
  else if (key === 'e' && mine && !props.readOnly) { event.preventDefault(); startEdit(message) }
  else if (key === 'r' && !props.readOnly) { event.preventDefault(); emit('reply', message.id) }
  else if (key === 't' && canThread(message)) { event.preventDefault(); emit('thread', message) }
  else if (key === 'p' && canPinHere.value) { event.preventDefault(); void togglePin(message) }
  else if ((key === 'delete' || key === 'backspace') && (mine || props.canModerate)) { event.preventDefault(); remove(message.id, event.shiftKey) }
}

/* ------------------------------------------------------------------ jumping */

function highlight(id: string) {
  highlightId.value = id
  setTimeout(() => {
    if (highlightId.value === id) highlightId.value = null
  }, 2000)
}

/** Scrolls to a message, loading the history around it first when needed. */
async function focusMessage(id: string) {
  if (!messages.value.some(message => message.id === id)) {
    jumpingToId.value = id
    try {
      const context = await api<MessageContextResponse>(`/api/channels/${props.channelId}/messages/${id}/context`)
      await qc.cancelQueries({ queryKey: messagesKey.value, exact: true })
      qc.setQueryData<InfiniteData<MessagePage>>(messagesKey.value, current => mergeMessageContext(current, context))
      await nextTick()
    }
    catch {
      toast.add({ title: 'That message is no longer available', color: 'error' })
      return
    }
    finally {
      jumpingToId.value = null
    }
  }
  pinned.value = false
  const index = messages.value.findIndex(message => message.id === id)
  if (index >= 0) virtualizer.value.scrollToIndex(index, { align: 'center' })
  await nextTick()
  requestAnimationFrame(() => {
    document.getElementById(`message-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  })
  highlight(id)
}

async function goToResult(hit: MessageSearchHitDTO) {
  ui.searchOpen = false
  if (hit.channel.id !== props.channelId) {
    await navigateTo(`${hit.channel.path}?message=${encodeURIComponent(hit.id)}`)
    return
  }
  await focusMessage(hit.id)
}

// `?message=` from a copied link. Only the list showing that conversation acts:
// a thread URL targets the thread panel's list.
const linkedTarget = computed(() => String(route.value.params.threadId || route.value.params.channel || route.value.params.channelId || ''))
watch(() => [route.value.query.message, q.isSuccess.value] as const, async ([messageId, ready]) => {
  if (typeof messageId !== 'string' || !ready || linkedTarget.value !== props.channelId) return
  // Let the loaded page render first, so a message already in it needs no extra fetch.
  await nextTick()
  await focusMessage(messageId)
  const { message: _message, ...query } = route.value.query
  void navigateTo({ path: route.value.path, query }, { replace: true })
}, { immediate: true })

watch(() => ui.searchOpen, (open) => {
  if (!open) ui.searchQuery = ''
})

defineExpose({ focusMessage })
</script>

<template>
  <div class="relative flex min-h-0 flex-1 flex-col">
    <div
      ref="scroller"
      class="flex flex-1 flex-col overflow-y-auto overflow-x-hidden [overflow-anchor:none]"
      :class="prefs.compact ? 'text-[13px]' : 'text-[15px]'"
      role="log"
      aria-live="polite"
      aria-relevant="additions"
      @scroll.passive="onScroll"
    >
      <div class="flex-1 min-h-4" />
      <div v-if="q.isPending.value" class="flex flex-1 flex-col">
        <LayoutSkeleton variant="messages" class="flex-1" />
      </div>
      <LayoutLoadError v-else-if="q.error.value" class="my-auto" message="Messages did not load." :retry="q.refetch" />
      <div v-else-if="showIntro && !q.hasNextPage.value" class="px-4 pt-4 pb-2">
        <div class="size-16 rounded-full bg-accented flex items-center justify-center mb-2">
          <UIcon :name="isDm ? 'i-ph-at' : 'i-ph-hash'" class="size-9 text-highlighted" />
        </div>
        <h2 class="text-[32px] leading-tight font-bold text-highlighted tracking-tight">
          Welcome to {{ isDm ? '' : '#' }}{{ channelName || 'channel' }}{{ isDm ? '' : '!' }}
        </h2>
        <p class="mt-1 text-muted text-[15px]">
          {{ isDm ? `This is the beginning of your direct message history.` : `This is the start of the #${channelName || 'channel'} channel.` }}
        </p>
      </div>
      <div v-if="q.isFetchingNextPage.value" class="px-4 py-2">
        <LayoutSkeleton variant="messages" :rows="3" />
      </div>
      <UContextMenu v-if="messages.length" :items="contextItems" :modal="false">
        <div
          ref="content"
          class="relative shrink-0 pb-2"
          :style="{ height: `${virtualizer.getTotalSize()}px` }"
          @contextmenu.capture="onContextMenu"
          @pointerover="onPointerOver"
          @pointerleave="activeId = null"
          @focusin="onFocusIn"
          @keydown="onRowKey"
        >
          <div v-for="{ message: m, index: i, key, start } in virtualRows" :key="String(key)" :ref="measureRow" :data-index="i" class="absolute inset-x-0 top-0 flow-root" :style="{ transform: `translateY(${start - contentMargin}px)` }">
            <div v-if="i === 0 || !sameDay(m.createdAt, messages[i - 1]!.createdAt)" class="mx-4 mt-6 mb-2 flex items-center" role="separator">
              <div class="flex-1 border-t" :class="unreadBoundary === m.id ? 'border-error/70' : 'border-default'" />
              <span class="px-2 text-xs font-semibold text-muted">{{ formatDayLabel(m.createdAt) }}</span>
              <div class="flex-1 border-t" :class="unreadBoundary === m.id ? 'border-error/70' : 'border-default'" />
              <span v-if="unreadBoundary === m.id" class="rounded-sm bg-error px-1 text-[11px] font-bold uppercase leading-4 text-inverted">New</span>
            </div>
            <div
              v-else-if="unreadBoundary === m.id"
              class="relative mx-4 mt-3 mb-1 flex items-center border-t border-error/70"
              role="separator"
              aria-label="New messages"
            >
              <span class="absolute end-0 -top-2 rounded-sm bg-error px-1 text-[11px] font-bold uppercase leading-4 text-inverted">New</span>
            </div>
            <ChatMessageItem
              :id="`message-${m.id}`"
              :message="m"
              :context-only="m.channelId !== channelId"
              :thread="threadsByMessage.get(m.id)"
              :task-links="taskLinksByMessage.get(m.id)"
              :names="names"
              :member="membersById.get(m.author.id)"
              :mine="m.author.id === session.user?.id"
              :can-pin="canPinHere"
              :can-thread="canThread(m)"
              :read-only="readOnly"
              :compact="unreadBoundary !== m.id && messages[i - 1]?.channelId === m.channelId && compactWith(m, messages[i - 1])"
              :streaming="streamingMessageIds.has(m.id)"
              :active="activeId === m.id"
              :editing="editingId === m.id"
              :highlighted="highlightId === m.id"
              :mentions-me="mentionsMe(m)"
              :actions="activeId === m.id ? actionsFor(m) : undefined"
              @reply="emit('reply', m.id)"
              @edit="startEdit(m)"
              @save-edit="saveEdit(m)"
              @cancel-edit="ui.cancelEditing(channelId)"
              @remove="(immediate) => remove(m.id, immediate)"
              @thread="canThread(m) && emit('thread', m)"
              @jump="focusMessage"
              @react="(emoji) => react(m.id, emoji)"
              @pin="togglePin(m)"
              @retry="m.clientId && emit('retry', m.clientId)"
              @longpress="sheetMessage = m"
            />
          </div>
        </div>
      </UContextMenu>
    </div>

    <Transition
      enter-active-class="transition duration-150 ease-out"
      enter-from-class="translate-y-2 opacity-0"
      leave-active-class="transition duration-100 ease-in"
      leave-to-class="translate-y-2 opacity-0"
    >
      <div v-if="!pinned && messages.length" class="pointer-events-none absolute inset-x-4 bottom-2 z-20 flex justify-center">
        <button
          type="button"
          class="pointer-events-auto flex items-center gap-2 rounded-full bg-primary px-3 py-1.5 text-sm font-medium text-inverted shadow-lg hover:bg-primary/90"
          @click="jumpToPresent"
        >
          <span v-if="unseen">{{ unseen === 1 ? '1 new message' : `${unseen > 99 ? '99+' : unseen} new messages` }}</span>
          <span v-else>Jump to present</span>
          <UIcon name="i-ph-arrow-down-bold" class="size-3.5" />
        </button>
      </div>
    </Transition>

    <UModal v-if="ownsSearch" v-model:open="ui.searchOpen" :ui="{ content: 'sm:max-w-2xl' }">
      <template #content>
        <div class="p-3">
          <UInput
            v-model="ui.searchQuery"
            icon="i-ph-magnifying-glass"
            size="xl"
            :placeholder="ui.searchScope === 'server' ? 'Search all conversations' : 'Search this conversation'"
            autofocus
            class="w-full"
          />
          <UTabs v-model="ui.searchScope" :items="searchScopes" :content="false" size="xs" variant="link" class="mt-2" />
          <div v-if="ui.searchQuery.trim()" class="mt-2 max-h-96 overflow-y-auto">
            <div v-if="searchLoading" class="p-3">
              <LayoutSkeleton variant="rows" :rows="3" />
            </div>
            <UAlert v-else-if="searchReady && searchQ.error.value" color="error" variant="subtle" title="Could not search messages." />
            <template v-else>
              <button
                v-for="message in searchResults"
                :key="message.id"
                type="button"
                class="flex w-full items-center gap-3 rounded-md px-3 py-2 text-start hover:bg-elevated"
                :disabled="Boolean(jumpingToId)"
                @click="goToResult(message)"
              >
                <UserAvatar :user="message.author" size="xs" />
                <span class="min-w-0 flex-1">
                  <span class="flex items-center gap-2 text-xs">
                    <strong class="truncate text-highlighted">{{ message.author.displayName }}</strong>
                    <span v-if="message.channel.id !== channelId" class="flex min-w-0 items-center gap-1 text-muted">
                      <UIcon :name="message.channel.type === 'thread' ? 'i-ph-chat-circle-text' : message.channel.type === 'dm' ? 'i-ph-user' : 'i-ph-hash'" class="size-3 shrink-0" />
                      <span class="truncate">{{ message.channel.type === 'thread' ? `${message.channel.title} › ${message.channel.name}` : message.channel.title }}</span>
                    </span>
                    <time class="shrink-0 text-muted">{{ formatMessageTime(message.createdAt) }}</time>
                  </span>
                  <span class="block truncate text-sm text-muted">{{ humanizeMentions(message.content, names) }}</span>
                </span>
                <UIcon v-if="jumpingToId === message.id" name="i-ph-spinner" class="size-4 shrink-0 animate-spin text-muted" />
              </button>
            </template>
            <p v-if="searchEmpty" class="px-3 py-8 text-center text-sm text-muted">No matches</p>
            <UButton
              v-if="searchReady && searchQ.hasNextPage.value"
              class="mx-auto mt-2 flex"
              color="neutral"
              variant="ghost"
              size="xs"
              :loading="searchQ.isFetchingNextPage.value"
              label="Load more"
              @click="searchQ.fetchNextPage()"
            />
          </div>
        </div>
      </template>
    </UModal>

    <UModal :open="Boolean(removeId)" title="Delete message" @update:open="(value: boolean) => { if (!value) removeId = null }">
      <template #body>
        <p class="text-sm text-muted">Are you sure you want to delete this message? It is removed for everyone in this conversation.</p>
        <p class="mt-3 text-xs text-muted"><span class="font-semibold text-success">Tip:</span> hold Shift when clicking delete to skip this confirmation.</p>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" label="Cancel" @click="removeId = null" />
        <UButton color="error" label="Delete" :loading="removing" @click="confirmRemove" />
      </template>
    </UModal>

    <UDrawer v-model:open="sheetOpen" :title="sheetMessage ? `Message from ${sheetMessage.author.displayName}` : 'Message'" :ui="{ title: 'sr-only', header: 'hidden' }">
      <template #body>
        <div v-if="sheetMessage" class="space-y-3">
          <div v-if="!readOnly" class="flex justify-between gap-1">
            <button
              v-for="e in quickReactions().slice(0, 6)"
              :key="e"
              type="button"
              class="flex size-12 items-center justify-center rounded-full bg-elevated text-2xl active:bg-accented"
              :aria-label="`React with ${e}`"
              @click="reactFromSheet(e)"
            >
              {{ e }}
            </button>
          </div>
          <p class="px-1 text-xs text-muted">{{ formatFullDateTime(sheetMessage.createdAt) }}</p>
          <div v-for="(group, index) in sheetActions" :key="index" class="divide-y divide-default overflow-hidden rounded-xl bg-elevated">
            <button
              v-for="item in group"
              :key="String(item.label)"
              type="button"
              class="sheet-action"
              :class="item.color === 'error' ? 'text-error' : ''"
              @click="runSheet(item)"
            >
              <UIcon :name="String(item.icon)" class="size-5" />{{ item.label }}
            </button>
          </div>
        </div>
      </template>
    </UDrawer>
  </div>
</template>

<style scoped>
.sheet-action {
  display: flex;
  width: 100%;
  min-height: 3.25rem;
  align-items: center;
  gap: 0.875rem;
  padding-inline: 1rem;
  text-align: start;
  font-size: 0.9375rem;
}

.sheet-action:active {
  background: var(--ui-bg-accented);
}
</style>
