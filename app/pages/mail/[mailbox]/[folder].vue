<script setup lang="ts">
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/vue-query'
import type { AttachmentDTO, MailboxDTO, MailMessageDTO, MailThreadDTO, MailThreadPageDTO, MailThreadStatus } from '~~/shared/types'
import { forwardedEmail, mailReplyRecipients, mergeMailAddresses } from '~~/shared/mail'
import { formatDateTime } from '~~/shared/format'
import { isMailFolder, mailPath, type MailFolder } from '~~/shared/paths'
import { withMailboxUnread, withMessage, withoutMessage, withoutThread, withThreadActivity, withThreadFirst, withThreadRead, type MailThreadDetail, type MailThreadPages } from '~/utils/mail-cache'

const { serverId } = useServer()

definePageMeta({ layout: 'server', middleware: ['auth'] })

const { api, serverUrl } = useApi()
const route = useRoute()
const qc = useQueryClient()
const toast = useToast()
const nav = useNavActions()
const session = useSessionStore()
const ui = useUiStore()

/** Mailbox, folder and open thread all live in the URL so the sidebar can link to them. */
const activeMailboxId = computed(() => String(route.params.mailbox || '') || null)
const folder = computed<MailFolder>(() => {
  const value = String(route.params.folder || 'inbox')
  return isMailFolder(value) ? value : 'inbox'
})
const activeThreadId = computed(() => String(route.query.thread || '') || null)

const composerMode = ref<'reply' | 'note'>('reply')
const replyAll = ref(false)
const replyTo = ref('')
const replyToEdited = ref(false)
/** Addresses typed into a To, Cc or Bcc field, separated by commas, semicolons or spaces. */
function addressesIn(value: string) { return mergeMailAddresses(value.split(/[;,\s]+/u).filter(Boolean)) }
const replyAddresses = computed(() => addressesIn(replyTo.value))
const replyCc = ref('')
const replyBcc = ref('')
const replyCopies = ref(false)
const uncertainRetry = ref<MailMessageDTO | null>(null)
const draft = ref('')
const sending = ref(false)
const composeTo = ref('')
const composeSubject = ref('')
const composeBody = ref('')
const composeCc = ref('')
const composeBcc = ref('')
const composeCopies = ref(false)
const composeFiles = ref<AttachmentDTO[]>([])
const replyFiles = ref<AttachmentDTO[]>([])
const uploadingFiles = ref(0)
/** Searches the open folder of this mailbox. */
const searchInput = ref('')
const search = refDebounced(computed(() => searchInput.value.trim()), 300)
// Each email carries a key; retrying one after a dropped connection reuses it, so it is sent once.
const newRequestKey = () => crypto.randomUUID()
const replyKey = ref(newRequestKey())
const composeKey = ref(newRequestKey())

function openThread(threadId: string | null) {
  void navigateTo({ query: threadId ? { thread: threadId } : {} })
}

// New mail arrives over the server connection; polling is only a fallback.
const mailboxesQ = useQuery({
  queryKey: ['mailboxes'],
  queryFn: () => api<{ mailboxes: MailboxDTO[] }>('/api/mail/mailboxes'),
  refetchInterval: 60_000,
})
const mailboxes = computed(() => mailboxesQ.data.value?.mailboxes ?? [])
const activeMailbox = computed(() => mailboxes.value.find(mailbox => mailbox.channelId === activeMailboxId.value) ?? null)
const canSend = computed(() => activeMailbox.value?.permission === 'send' || activeMailbox.value?.permission === 'manage')
const filesAvailable = computed(() => activeMailbox.value?.attachments !== false)
const threadsKey = computed(() => ['mail-threads', activeMailboxId.value, folder.value, search.value] as const)
const threadsQ = useInfiniteQuery({
  queryKey: threadsKey,
  queryFn: ({ pageParam }) => api<MailThreadPageDTO>(`/api/mail/mailboxes/${activeMailboxId.value}/threads`, {
    query: { status: folder.value, before: pageParam || undefined, q: search.value || undefined },
  }),
  initialPageParam: '',
  getNextPageParam: last => last.nextCursor ?? undefined,
  enabled: computed(() => Boolean(activeMailboxId.value)),
  refetchInterval: 60_000,
})
const threads = computed(() => threadsQ.data.value?.pages.flatMap(page => page.threads) ?? [])

function fetchThread(threadId: string) {
  return api<MailThreadDetail>(`/api/mail/threads/${threadId}`)
}
const threadQ = useQuery({
  queryKey: computed(() => ['mail-thread', activeThreadId.value]),
  queryFn: () => fetchThread(activeThreadId.value!),
  enabled: computed(() => Boolean(activeThreadId.value)),
  staleTime: 15_000,
  refetchInterval: 60_000,
  // Show the conversation's subject and people from the list while its messages load.
  placeholderData: () => {
    const item = threads.value.find(thread => thread.channelId === activeThreadId.value)
    return item ? { thread: item, messages: [] } : undefined
  },
})
const thread = computed(() => threadQ.data.value?.thread ?? null)
const messages = computed(() => threadQ.data.value?.messages ?? [])
const defaultRecipients = computed(() => mailReplyRecipients(
  [...messages.value].reverse().find(message => message.email?.direction === 'inbound')?.email ?? null,
  thread.value?.participants ?? [], activeMailbox.value?.address ?? '', replyAll.value,
).join(', '))
watch(defaultRecipients, (value) => { if (!replyToEdited.value) replyTo.value = value }, { immediate: true })
watch(replyAll, () => { replyToEdited.value = false; replyTo.value = defaultRecipients.value })
const loadingMessages = computed(() => Boolean(activeThreadId.value) && (threadQ.isPending.value || threadQ.isPlaceholderData.value))

/** Hovering a conversation loads it, so opening it is immediate. Loading does not mark it read. */
function prefetchThread(threadId: string) {
  void qc.prefetchQuery({ queryKey: ['mail-thread', threadId], queryFn: () => fetchThread(threadId), staleTime: 15_000 })
}

/** A mailbox that disappeared (access revoked, renamed) shouldn't leave a dead URL. */
watch([mailboxes, activeMailboxId], ([items, id]) => {
  if (!items.length || !id) return
  if (!items.some(item => item.channelId === id)) void navigateTo(mailPath(items[0]!.channelId), { replace: true })
}, { immediate: true })

/** Whether a conversation with this status still belongs in the open folder. */
function listedHere(status: MailThreadStatus) {
  return folder.value === 'sent' ? status !== 'spam' && status !== 'trash' : status === folder.value
}

/** A conversation moved to another folder elsewhere closes here. */
watch(() => threadQ.data.value?.thread.status, (status) => {
  if (status && !threadQ.isPlaceholderData.value && !listedHere(status)) openThread(null)
})

watch(activeThreadId, () => {
  replyToEdited.value = false
  replyAll.value = false
  replyTo.value = defaultRecipients.value
  uncertainRetry.value = null
  draft.value = ''
  composerMode.value = 'reply'
  replyKey.value = newRequestKey()
  replyCc.value = ''
  replyBcc.value = ''
  replyCopies.value = false
  replyFiles.value = []
})
watch(folder, () => { searchInput.value = '' })

/** Marks the open conversation read once its newest message is on screen. */
const readUpTo = new Map<string, string>()
watch(() => [activeThreadId.value, threadQ.isPlaceholderData.value ? null : messages.value.at(-1)?.id] as const, ([threadId, latestId]) => {
  if (!threadId || !latestId || latestId.startsWith('tmp:') || (readUpTo.get(threadId) ?? '') >= latestId) return
  readUpTo.set(threadId, latestId)
  const wasUnread = threads.value.find(item => item.channelId === threadId)?.unread
  qc.setQueriesData<MailThreadPages>({ queryKey: ['mail-threads', activeMailboxId.value] }, data => withThreadRead(data, threadId))
  if (wasUnread && folder.value === 'inbox' && activeMailboxId.value) {
    qc.setQueryData<{ mailboxes: MailboxDTO[] }>(['mailboxes'], data => withMailboxUnread(data, activeMailboxId.value!, -1))
  }
  void api(`/api/mail/threads/${threadId}/read`, { method: 'POST', body: { messageId: latestId } })
    .catch(() => readUpTo.delete(threadId))
}, { immediate: true })

function pendingMessage(threadId: string, content: string, key: string, attachments: AttachmentDTO[]): MailMessageDTO {
  const user = session.user!
  return {
    id: `tmp:${key}`,
    channelId: threadId,
    serverId: serverId.value,
    author: { id: user.id, kind: user.kind, displayName: user.displayName, avatarR2Key: user.avatarR2Key },
    content,
    replyTo: null,
    mentions: [],
    attachments,
    reactions: [],
    pin: null,
    threadId: null,
    editedAt: null,
    deletedAt: null,
    createdAt: new Date().toISOString(),
    email: composerMode.value === 'reply'
      ? {
          direction: 'outbound',
          fromAddress: activeMailbox.value?.address ?? '',
          fromName: activeMailbox.value?.displayName ?? null,
          to: replyAddresses.value,
          cc: addressesIn(replyCc.value),
          bcc: addressesIn(replyBcc.value),
          deliveryStatus: 'pending',
          deliveryError: null,
        }
      : null,
  }
}

function deliveryFailed(message: MailMessageDTO, kind: 'reply' | 'email' = 'reply') {
  toast.add({
    title: `Your ${kind} was saved but not delivered`,
    description: message.email?.deliveryError || 'You can retry it from the conversation.',
    color: 'error',
  })
}

/** The reply shows at once as Sending and is replaced by the saved email when the server answers. */
async function send() {
  const threadId = activeThreadId.value
  const content = draft.value.trim()
  if (!threadId || !content || !canSend.value || uploadingFiles.value) return
  const mode = composerMode.value
  const key = replyKey.value
  const files = mode === 'reply' ? replyFiles.value : []
  const pending = pendingMessage(threadId, content, key, files)
  qc.setQueryData<MailThreadDetail>(['mail-thread', threadId], detail => withMessage(detail, pending))
  draft.value = ''
  if (mode === 'reply') replyFiles.value = []
  try {
    const result = await api<{ message: MailMessageDTO }>(`/api/mail/threads/${threadId}/${mode}`, {
      method: 'POST',
      body: mode === 'reply'
        ? { content, clientId: key, to: replyAddresses.value, cc: addressesIn(replyCc.value), bcc: addressesIn(replyBcc.value), attachmentIds: files.map(file => file.id) }
        : { content },
    })
    replyKey.value = newRequestKey()
    if (mode === 'reply') { replyCc.value = ''; replyBcc.value = '' }
    qc.setQueryData<MailThreadDetail>(['mail-thread', threadId], detail => withMessage(detail, result.message, pending.id))
    qc.setQueriesData<MailThreadPages>({ queryKey: ['mail-threads', activeMailboxId.value] }, data => withThreadActivity(data, threadId, result.message))
    // A first reply puts the conversation in Sent.
    if (mode === 'reply') void qc.invalidateQueries({ queryKey: ['mail-threads', activeMailboxId.value, 'sent'] })
    if (result.message.email?.deliveryStatus === 'failed') deliveryFailed(result.message)
  }
  catch (error) {
    // Nothing was confirmed: put the text back so it can be sent again with the same key.
    qc.setQueryData<MailThreadDetail>(['mail-thread', threadId], detail => withoutMessage(detail, pending.id))
    if (!draft.value) draft.value = content
    if (mode === 'reply' && !replyFiles.value.length) replyFiles.value = files
    toast.add({ title: errorMessage(error), color: 'error' })
  }
}

async function retry(message: MailMessageDTO, confirmUncertain = false) {
  if (message.email?.deliveryUncertain && !confirmUncertain) { uncertainRetry.value = message; return }
  const threadId = activeThreadId.value
  if (!threadId || !message.email) return
  uncertainRetry.value = null
  const sendingAgain = { ...message, email: { ...message.email, deliveryStatus: 'pending' as const, deliveryError: null, deliveryUncertain: false } }
  qc.setQueryData<MailThreadDetail>(['mail-thread', threadId], detail => withMessage(detail, sendingAgain))
  try {
    const result = await api<{ message: MailMessageDTO }>(`/api/mail/threads/${threadId}/retry`, { method: 'POST', body: { messageId: message.id, confirmUncertain } })
    qc.setQueryData<MailThreadDetail>(['mail-thread', threadId], detail => withMessage(detail, result.message))
    if (result.message.email?.deliveryStatus === 'failed') deliveryFailed(result.message, 'email')
  }
  catch (error) {
    qc.setQueryData<MailThreadDetail>(['mail-thread', threadId], detail => withMessage(detail, message))
    toast.add({ title: errorMessage(error), color: 'error' })
  }
}

/**
 * Moving closes the conversation at once and takes it out of every folder it
 * leaves; it comes back if the server refuses. Archiving keeps it in Sent, like Gmail.
 */
async function move(status: MailThreadStatus) {
  const threadId = activeThreadId.value
  const mailboxId = activeMailboxId.value
  if (!threadId || !mailboxId) return
  const listKey = ['mail-threads', mailboxId] as const
  const snapshot = qc.getQueriesData<MailThreadPages>({ queryKey: listKey })
  for (const [key] of snapshot) {
    const keepsInSent = key[2] === 'sent' && status !== 'spam' && status !== 'trash'
    if (!keepsInSent) qc.setQueryData<MailThreadPages>(key, data => withoutThread(data, threadId))
  }
  qc.setQueryData<MailThreadDetail>(['mail-thread', threadId], detail => detail && { ...detail, thread: { ...detail.thread, status } })
  if (!listedHere(status)) openThread(null)
  try {
    await api(`/api/mail/threads/${threadId}`, { method: 'PATCH', body: { status } })
  }
  catch (error) {
    for (const [key, data] of snapshot) qc.setQueryData(key, data)
    toast.add({ title: errorMessage(error), color: 'error' })
  }
  finally {
    void qc.invalidateQueries({ queryKey: listKey })
    void qc.invalidateQueries({ queryKey: ['mailboxes'] })
  }
}

async function compose() {
  const mailboxId = activeMailboxId.value
  if (!mailboxId || !canSend.value || !composeSubject.value.trim() || !composeBody.value.trim() || uploadingFiles.value) return
  const to = addressesIn(composeTo.value)
  if (!to.length) return
  sending.value = true
  try {
    const result = await api<{ threadId: string; thread: MailThreadDTO; message: MailMessageDTO }>(`/api/mail/mailboxes/${mailboxId}/send`, {
      method: 'POST',
      body: {
        to, cc: addressesIn(composeCc.value), bcc: addressesIn(composeBcc.value), subject: composeSubject.value.trim(), content: composeBody.value.trim(),
        attachmentIds: composeFiles.value.map(file => file.id), clientId: composeKey.value,
      },
    })
    composeKey.value = newRequestKey()
    nav.composeOpen.value = false
    composeTo.value = ''
    composeSubject.value = ''
    composeBody.value = ''
    composeCc.value = ''
    composeBcc.value = ''
    composeCopies.value = false
    composeFiles.value = []
    qc.setQueryData<MailThreadDetail>(['mail-thread', result.threadId], { thread: result.thread, messages: [result.message] })
    // A conversation you start is in Sent; it reaches the Inbox once someone replies.
    qc.setQueryData<MailThreadPages>(['mail-threads', mailboxId, 'sent', ''], data => withThreadFirst(data, result.thread))
    if (result.message.email?.deliveryStatus === 'failed') deliveryFailed(result.message, 'email')
    await navigateTo(mailPath(mailboxId, 'sent', result.threadId))
  }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { sending.value = false }
}

/** Forward opens a new email with the original quoted, like any mail client, and copies its files. */
async function forward(message: MailMessageDTO) {
  const mailboxId = activeMailboxId.value
  if (!message.email || !mailboxId) return
  const forwarded = forwardedEmail({ subject: thread.value?.subject ?? '', date: formatDateTime(message.createdAt), content: message.content, ...message.email })
  composeTo.value = ''
  composeCc.value = ''
  composeBcc.value = ''
  composeCopies.value = false
  composeSubject.value = forwarded.subject
  composeBody.value = forwarded.body
  composeFiles.value = []
  composeKey.value = newRequestKey()
  nav.composeOpen.value = true
  if (!message.attachments.length) return
  if (!filesAvailable.value) { toast.add({ title: 'Attachments are not forwarded: this Server has no file storage', color: 'warning' }); return }
  uploadingFiles.value += 1
  try {
    for (const attachment of message.attachments) {
      const result = await api<{ attachment: AttachmentDTO }>(`/api/mail/mailboxes/${mailboxId}/attachments`, { method: 'POST', body: { forwardAttachmentId: attachment.id } })
      composeFiles.value = [...composeFiles.value, result.attachment]
    }
  }
  catch (error) { toast.add({ title: `Not every attachment was copied: ${errorMessage(error)}`, color: 'error' }) }
  finally { uploadingFiles.value -= 1 }
}

const folderLabel = computed(() => folder.value.charAt(0).toUpperCase() + folder.value.slice(1))

function messageSender(message: MailMessageDTO) {
  if (!message.email) return message.author.displayName
  if (message.email.direction === 'outbound') return activeMailbox.value?.displayName || message.email.fromAddress
  return message.email.fromName || message.email.fromAddress
}

const deliveryBadge = {
  pending: { label: 'Sending', color: 'neutral' },
  sent: { label: 'Sent', color: 'neutral' },
  failed: { label: 'Not delivered', color: 'error' },
  received: { label: 'Received', color: 'neutral' },
} as const
</script>

<template>
  <div class="h-full min-h-0 min-w-0">
    <!-- The conversation list is resizable, like the chat panels; the email gets the rest. -->
    <div class="grid h-full min-h-0 min-w-0 grid-cols-1 md:grid-cols-[var(--mail-list-width)_minmax(0,1fr)]" :style="{ '--mail-list-width': `${ui.mailListWidth}px` }">
      <section class="relative min-h-0 border-e border-default" :class="activeThreadId ? 'hidden md:block' : 'block'">
        <LayoutResizeHandle
          v-model="ui.mailListWidth"
          class="hidden md:block"
          :min="240"
          :max="560"
          side="end"
          label="Resize conversation list"
        />
        <div class="h-full overflow-y-auto">
        <div class="sticky top-0 z-10 flex h-12 items-center gap-2 border-b border-default bg-default/90 px-3 backdrop-blur">
          <LayoutMobileMenuButton />
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium text-highlighted">{{ folderLabel }}</p>
            <p class="truncate text-[11px] text-muted">{{ activeMailbox?.address || 'Mail' }}</p>
          </div>
          <UButton v-if="canSend" label="Compose" trailing-icon="i-ph-pencil-simple" size="sm" @click="nav.composeOpen.value = true" />
        </div>
        <div v-if="activeMailbox" class="border-b border-default px-3 py-2">
          <UInput v-model="searchInput" icon="i-ph-magnifying-glass" :placeholder="`Search ${folderLabel}`" :aria-label="`Search ${folderLabel}`" size="sm" class="w-full" />
        </div>
        <LayoutSkeleton v-if="threadsQ.isPending.value" variant="rows" :rows="6" />
        <div v-else-if="!mailboxes.length || !threads.length" class="px-6 py-16 text-center">
          <UIcon :name="mailboxes.length ? 'i-ph-tray' : 'i-ph-envelope-simple'" class="size-8 text-dimmed" />
          <p class="mt-3 text-sm font-medium text-highlighted">{{ !mailboxes.length ? 'No mailbox assigned' : search ? 'No conversations match' : `${folderLabel} is empty` }}</p>
          <p v-if="!mailboxes.length" class="mt-1 text-sm text-muted">Ask a server admin for access to a mailbox.</p>
        </div>
        <button
          v-for="item in threads"
          :key="item.channelId"
          type="button"
          class="block w-full border-b border-default px-4 py-3 text-start hover:bg-elevated/60"
          :class="item.channelId === activeThreadId ? 'bg-accented' : ''"
          @mouseenter="prefetchThread(item.channelId)"
          @focus="prefetchThread(item.channelId)"
          @click="openThread(item.channelId)"
        >
          <div class="flex items-baseline gap-2">
            <span class="min-w-0 flex-1 truncate text-sm" :class="item.unread ? 'font-semibold text-highlighted' : 'text-default'">{{ item.participants.join(', ') || 'Unknown sender' }}</span>
            <span class="shrink-0 text-[11px] text-muted">{{ formatDateTime(item.lastMessageAt) }}</span>
          </div>
          <p class="mt-0.5 truncate text-sm" :class="item.unread ? 'font-medium text-highlighted' : 'text-default'">{{ item.subject }}</p>
          <p class="mt-0.5 line-clamp-2 text-xs text-muted">{{ item.preview }}</p>
        </button>
        <div v-if="threadsQ.hasNextPage.value" class="p-3">
          <UButton
            label="Load older conversations"
            color="neutral"
            variant="soft"
            block
            :loading="threadsQ.isFetchingNextPage.value"
            @click="threadsQ.fetchNextPage()"
          />
        </div>
        </div>
      </section>

      <section class="flex min-h-0 min-w-0 flex-col" :class="activeThreadId ? 'flex' : 'hidden md:flex'">
        <template v-if="thread">
          <header class="flex min-h-12 items-center gap-2 border-b border-default px-3">
            <UButton icon="i-ph-arrow-left" color="neutral" variant="ghost" square class="md:hidden" aria-label="Back to mail" @click="openThread(null)" />
            <div class="min-w-0 flex-1">
              <h2 class="truncate text-sm font-semibold text-highlighted">{{ thread.subject }}</h2>
              <p class="truncate text-xs text-muted">{{ thread.participants.join(', ') }}</p>
            </div>
            <UTooltip text="Archive"><UButton icon="i-ph-archive" color="neutral" variant="ghost" square :disabled="!canSend" @click="move('archive')" /></UTooltip>
            <UTooltip text="Spam"><UButton icon="i-ph-warning" color="neutral" variant="ghost" square :disabled="!canSend" @click="move('spam')" /></UTooltip>
            <UTooltip text="Trash"><UButton icon="i-ph-trash" color="neutral" variant="ghost" square :disabled="!canSend" @click="move('trash')" /></UTooltip>
          </header>
          <div class="flex-1 space-y-2 overflow-y-auto p-3">
            <LayoutSkeleton v-if="loadingMessages && !messages.length" variant="messages" :rows="3" />
            <article v-for="message in messages" :key="message.id" class="rounded-lg border border-default bg-default px-4 py-3">
              <div class="flex items-start gap-3">
                <UserAvatar :user="message.author" size="sm" />
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-baseline gap-x-2">
                    <span class="font-medium text-highlighted">{{ messageSender(message) }}</span>
                    <UBadge v-if="!message.email" label="Internal note" color="warning" variant="subtle" size="sm" />
                    <UBadge
                      v-else-if="message.email.direction === 'outbound'"
                      :label="message.email.deliveryUncertain ? 'Delivery unknown' : deliveryBadge[message.email.deliveryStatus].label"
                      :color="deliveryBadge[message.email.deliveryStatus].color"
                      :icon="message.email.deliveryStatus === 'pending' && !message.email.deliveryUncertain ? 'i-ph-circle-notch' : undefined"
                      :ui="{ leadingIcon: 'animate-spin' }"
                      variant="subtle"
                      size="sm"
                    />
                    <span class="text-xs text-muted">{{ formatDateTime(message.createdAt) }}</span>
                  </div>
                  <p v-if="message.email" class="mt-0.5 truncate text-xs text-muted">
                    {{ message.email.direction === 'outbound' ? `To ${message.email.to.join(', ')}` : `From ${message.email.fromAddress}` }}<template v-if="message.email.cc.length"> · Cc {{ message.email.cc.join(', ') }}</template><template v-if="message.email.direction === 'outbound' && message.email.bcc.length"> · Bcc {{ message.email.bcc.join(', ') }}</template>
                  </p>
                </div>
                <UTooltip v-if="message.email && canSend && !message.id.startsWith('tmp:')" text="Forward"><UButton icon="i-ph-arrow-bend-double-up-right" color="neutral" variant="ghost" size="xs" square aria-label="Forward" @click="forward(message)" /></UTooltip>
              </div>
              <p class="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-default">{{ message.content }}</p>
              <div v-if="message.email?.deliveryStatus === 'failed' || message.email?.deliveryUncertain" class="mt-3 flex flex-wrap items-center gap-2 rounded-md bg-error/10 px-3 py-2 text-sm text-error">
                <UIcon name="i-ph-warning-circle" class="size-4 shrink-0" />
                <span class="min-w-0 flex-1">{{ message.email?.deliveryUncertain ? 'Delivery could not be confirmed. The recipient may already have this email.' : message.email?.deliveryError || 'This email was not delivered.' }}</span>
                <UButton v-if="canSend" :label="message.email?.deliveryUncertain ? 'Send again…' : 'Retry'" size="xs" color="error" variant="soft" @click="retry(message)" />
              </div>
              <div v-if="message.attachments.length" class="mt-4 flex flex-wrap gap-2">
                <UButton
                  v-for="attachment in message.attachments"
                  :key="attachment.id"
                  :to="serverUrl(attachment.url)"
                  target="_blank"
                  :label="attachment.filename"
                  icon="i-ph-paperclip"
                  color="neutral"
                  variant="soft"
                  size="sm"
                />
              </div>
            </article>
          </div>
          <form v-if="canSend" class="border-t border-default p-3" @submit.prevent="send">
            <div class="mb-2 flex items-center gap-1">
              <UButton label="Reply" size="xs" color="neutral" :variant="composerMode === 'reply' ? 'soft' : 'ghost'" @click="composerMode = 'reply'" />
              <UButton v-if="composerMode === 'reply'" :label="replyAll ? 'Reply all' : 'Reply to sender'" size="xs" color="neutral" variant="ghost" @click="replyAll = !replyAll" />
              <UButton label="Internal note" size="xs" color="warning" :variant="composerMode === 'note' ? 'soft' : 'ghost'" @click="composerMode = 'note'" />
              <UButton v-if="composerMode === 'reply' && !replyCopies" label="Cc/Bcc" size="xs" color="neutral" variant="ghost" class="ms-auto" @click="replyCopies = true" />
            </div>
            <UFormField v-if="composerMode === 'reply'" label="To" hint="Separate addresses with commas" class="mb-2">
              <UInput v-model="replyTo" class="w-full" @update:model-value="replyToEdited = true" />
            </UFormField>
            <div v-if="composerMode === 'reply' && replyCopies" class="mb-2 grid gap-2 sm:grid-cols-2">
              <UFormField label="Cc"><UInput v-model="replyCc" class="w-full" /></UFormField>
              <UFormField label="Bcc" hint="Hidden from other recipients"><UInput v-model="replyBcc" class="w-full" /></UFormField>
            </div>
            <UTextarea v-model="draft" :placeholder="composerMode === 'reply' ? 'Reply by email' : 'Write a note for the server'" autoresize :maxrows="8" class="w-full" />
            <div class="mt-2 flex items-start justify-between gap-2">
              <MailAttachments v-if="composerMode === 'reply' && activeMailboxId" v-model="replyFiles" v-model:uploading="uploadingFiles" :mailbox-id="activeMailboxId" :available="filesAvailable" class="min-w-0" />
              <UButton type="submit" class="ms-auto shrink-0" :label="composerMode === 'reply' ? 'Send reply' : 'Add note'" trailing-icon="i-ph-paper-plane-tilt" :disabled="!draft.trim() || uploadingFiles > 0 || (composerMode === 'reply' && !replyAddresses.length)" />
            </div>
          </form>
          <div v-else class="border-t border-default p-4 text-sm text-muted">Read only</div>
        </template>
        <LayoutSkeleton v-else-if="activeThreadId && threadQ.isPending.value" variant="messages" :rows="3" class="p-4" />
        <div v-else class="grid flex-1 place-items-center text-sm text-muted">Choose a conversation</div>
      </section>
    </div>

    <UModal :open="Boolean(uncertainRetry)" title="Send another copy?" @update:open="value => { if (!value) uncertainRetry = null }">
      <template #body><p class="text-sm text-muted">The recipient may already have this email. Sending again may deliver a duplicate.</p></template>
      <template #footer>
        <UButton label="Cancel" color="neutral" variant="ghost" @click="uncertainRetry = null" />
        <UButton label="Send another copy" color="warning" @click="uncertainRetry && retry(uncertainRetry, true)" />
      </template>
    </UModal>
    <UModal v-model:open="nav.composeOpen.value" title="New email">
      <template #body>
        <div class="space-y-4">
          <UFormField label="To" hint="Separate addresses with commas"><UInput v-model="composeTo" type="text" autofocus class="w-full" /></UFormField>
          <UButton v-if="!composeCopies" label="Add Cc/Bcc" size="xs" color="neutral" variant="ghost" @click="composeCopies = true" />
          <template v-else>
            <UFormField label="Cc"><UInput v-model="composeCc" class="w-full" /></UFormField>
            <UFormField label="Bcc" hint="Hidden from other recipients"><UInput v-model="composeBcc" class="w-full" /></UFormField>
          </template>
          <UFormField label="Subject"><UInput v-model="composeSubject" class="w-full" /></UFormField>
          <UFormField label="Message"><UTextarea v-model="composeBody" :rows="8" class="w-full" /></UFormField>
          <MailAttachments v-if="activeMailboxId" v-model="composeFiles" v-model:uploading="uploadingFiles" :mailbox-id="activeMailboxId" :available="filesAvailable" />
        </div>
      </template>
      <template #footer>
        <UButton label="Cancel" color="neutral" variant="ghost" @click="nav.composeOpen.value = false" />
        <UButton label="Send email" trailing-icon="i-ph-paper-plane-tilt" :loading="sending" :disabled="!composeTo.trim() || !composeSubject.trim() || !composeBody.trim() || uploadingFiles > 0" @click="compose" />
      </template>
    </UModal>
  </div>
</template>
