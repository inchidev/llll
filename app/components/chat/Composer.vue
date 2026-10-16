<script setup lang="ts">
import type { ClientMsg, MemberDTO, MessageDTO } from '~~/shared/types'
import { formatAudioDuration } from '~~/shared/audio'
import { claimComposerSubmission, type ComposerSubmission } from '~~/shared/composer'
import { activeTrigger, applyMentionTokens, humanizeMentions } from '~~/shared/mentions'
import { replaceShortcodes, searchEmoji } from '~~/shared/emoji'
import { MAX_ATTACHMENT_BYTES } from '~~/shared/mime'
import { formatBytes } from '~~/shared/format'
import { newId, nowIso } from '~~/shared/ids'
import { useQueryClient, type InfiniteData } from '@tanstack/vue-query'
import { useEventListener, useFileDialog } from '@vueuse/core'
import AttachmentDraftPreview from '~/features/attachments/components/AttachmentDraftPreview.vue'
import { useAudioRecorder } from '~/features/attachments/composables/useAudioRecorder'
import { createTypingActivity } from '~/utils/typing-activity'

const props = defineProps<{
  channelId: string
  workspaceId: string
  members: MemberDTO[]
  send: (msg: ClientMsg) => void
  placeholder?: string
  disabled?: boolean
  disabledPlaceholder?: string
  canAttach?: boolean
  agentBusy?: boolean
  /** The conversation's main composer: focuses on open and when typing anywhere. */
  primary?: boolean
}>()

const MAX_LENGTH = 2000
const MAX_FILES = 8

const ui = useUiStore()
const session = useSessionStore()
const qc = useQueryClient()
const toast = useToast()
const { api } = useApi()
const files = ref<File[]>([])
const emojiOpen = ref(false)
const field = ref<{ textareaRef?: HTMLTextAreaElement } | null>(null)
const agentMode = ref<'queue' | 'steer'>('queue')
const agentModes = [
  { label: 'Queue', value: 'queue' },
  { label: 'Steer', value: 'steer' },
]
const draft = computed({
  get: () => ui.composerState(props.channelId).draft,
  set: value => ui.setComposerDraft(props.channelId, value),
})
const replyToId = computed(() => ui.composerState(props.channelId).replyToId)
const names = computed(() => {
  const map: Record<string, string> = {}
  for (const m of props.members) map[m.user.id] = m.nickname || m.user.displayName
  return map
})

type Page = { messages: MessageDTO[]; nextCursor: string | null }

function cachedMessages(): MessageDTO[] {
  const data = qc.getQueryData<InfiniteData<Page>>(['messages', props.channelId])
  return [...(data?.pages ?? [])].reverse().flatMap(page => page.messages)
}

const replyTarget = computed(() => {
  const id = replyToId.value
  if (!id) return null
  const message = cachedMessages().find(item => item.id === id)
  return message ? { name: names.value[message.author.id] || message.author.displayName } : { name: 'message' }
})

function textarea() {
  return field.value?.textareaRef ?? null
}

function focus() {
  const el = textarea()
  if (!el || props.disabled) return
  el.focus()
}

/* ------------------------------------------------------------------ files */

const { open: openFiles, reset: resetFiles, onChange } = useFileDialog({
  multiple: true,
  accept: '.png,.jpg,.jpeg,.webp,.gif,.pdf,.txt,.zip,.webm,.m4a,.ogg,.oga,.wav',
})
onChange((list) => {
  if (list) addFiles(Array.from(list))
  resetFiles()
})

const attachmentsDisabled = computed(() => props.disabled || props.canAttach === false || session.health?.bindings.r2 === false)

function addFiles(incoming: File[]) {
  if (!incoming.length) return
  if (attachmentsDisabled.value) {
    toast.add({ title: 'You cannot attach files here', color: 'error' })
    return
  }
  const tooLarge = incoming.filter(file => file.size > MAX_ATTACHMENT_BYTES)
  if (tooLarge.length) {
    toast.add({ title: `${tooLarge.length === 1 ? tooLarge[0]!.name : `${tooLarge.length} files`} ${tooLarge.length === 1 ? 'is' : 'are'} over the ${formatBytes(MAX_ATTACHMENT_BYTES)} limit`, color: 'error' })
  }
  const accepted = incoming.filter(file => file.size <= MAX_ATTACHMENT_BYTES)
  const room = MAX_FILES - files.value.length
  if (accepted.length > room) toast.add({ title: `A message can contain up to ${MAX_FILES} attachments`, color: 'error' })
  files.value = [...files.value, ...accepted.slice(0, Math.max(0, room))]
  focus()
}

function onPaste(event: ClipboardEvent) {
  const pasted = Array.from(event.clipboardData?.files ?? [])
  if (!pasted.length) return
  event.preventDefault()
  addFiles(pasted.map((file, index) => file.name && file.name !== 'image.png'
    ? file
    : new File([file], `pasted-${Date.now()}${index ? `-${index}` : ''}.${file.type.split('/')[1] || 'png'}`, { type: file.type })))
}

const {
  recording,
  elapsedMs,
  start: startAudioRecording,
  stop: stopAudioRecording,
  cancel: cancelAudioRecording,
} = useAudioRecorder({
  onRecorded(file) {
    addFiles([file])
  },
  onError(message) {
    toast.add({ title: message, color: 'error' })
  },
  onLimit() {
    toast.add({ title: 'Audio recording stopped at 5 minutes' })
  },
})
const recordingTime = computed(() => formatAudioDuration(elapsedMs.value))

function recordAudio() {
  if (attachmentsDisabled.value) return
  if (files.value.length >= MAX_FILES) {
    toast.add({ title: `A message can contain up to ${MAX_FILES} attachments`, color: 'error' })
    return
  }
  void startAudioRecording()
}

function removeFile(i: number) {
  files.value = files.value.filter((_, idx) => idx !== i)
}

/* ------------------------------------------------------------------ autocomplete */

type Suggestion = { key: string; label: string; detail?: string; insert: string; member?: MemberDTO; emoji?: string }

const caret = ref(0)
const suggestionIndex = ref(0)
const dismissedAt = ref<number | null>(null)

function syncCaret() {
  caret.value = textarea()?.selectionStart ?? draft.value.length
}

const trigger = computed(() => {
  const text = draft.value
  const mention = activeTrigger(text, caret.value, '@')
  if (mention) return { kind: 'mention' as const, ...mention }
  const emoji = activeTrigger(text, caret.value, ':')
  if (emoji) return { kind: 'emoji' as const, ...emoji }
  return null
})

const suggestions = computed<Suggestion[]>(() => {
  const active = trigger.value
  if (!active || dismissedAt.value === active.start || props.disabled) return []
  if (active.kind === 'emoji') {
    return searchEmoji(active.query, 8).map(entry => ({
      key: entry.name,
      label: `:${entry.name}:`,
      emoji: entry.emoji,
      insert: entry.emoji,
    }))
  }
  const needle = active.query.toLowerCase()
  return props.members
    .map((member) => {
      const display = member.user.displayName.toLowerCase()
      const nick = member.nickname?.toLowerCase() ?? ''
      const rank = !needle ? 1
        : display.startsWith(needle) || nick.startsWith(needle) ? 0
          : display.includes(needle) || nick.includes(needle) ? 1 : -1
      return { member, rank }
    })
    .filter(item => item.rank >= 0)
    // You can mention yourself, as in Discord, but everyone else comes first.
    .map(item => ({ ...item, rank: item.member.user.id === session.user?.id ? item.rank + 2 : item.rank }))
    .sort((a, b) => a.rank - b.rank || (a.member.nickname || a.member.user.displayName).localeCompare(b.member.nickname || b.member.user.displayName))
    .slice(0, 8)
    .map(({ member }) => ({
      key: member.user.id,
      label: member.nickname || member.user.displayName,
      detail: member.nickname ? member.user.displayName : member.user.kind === 'agent' ? 'AI agent' : undefined,
      insert: `@${member.nickname || member.user.displayName}`,
      member,
    }))
})

watch(suggestions, () => { suggestionIndex.value = 0 })

function accept(suggestion: Suggestion) {
  const active = trigger.value
  if (!active) return
  const text = draft.value
  const end = caret.value
  const insert = `${suggestion.insert} `
  draft.value = `${text.slice(0, active.start)}${insert}${text.slice(end)}`
  const position = active.start + insert.length
  nextTick(() => {
    const el = textarea()
    if (!el) return
    el.focus()
    el.setSelectionRange(position, position)
    caret.value = position
  })
}

/* ------------------------------------------------------------------ keys */

const touchInput = import.meta.client && window.matchMedia('(pointer: coarse)').matches

function editLastMessage() {
  const last = [...cachedMessages()].reverse().find(message => message.author.id === session.user?.id
    && !message.deletedAt && !message.id.startsWith('tmp:'))
  if (!last) return false
  ui.startEditing(props.channelId, last.id, humanizeMentions(last.content, names.value))
  return true
}

function onKey(event: KeyboardEvent) {
  if (event.isComposing) return
  if (suggestions.value.length) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      suggestionIndex.value = (suggestionIndex.value + step + suggestions.value.length) % suggestions.value.length
      return
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      const pick = suggestions.value[suggestionIndex.value]
      if (pick) accept(pick)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      dismissedAt.value = trigger.value?.start ?? null
      return
    }
  }
  if (event.key === 'Enter' && !event.shiftKey && !touchInput) {
    event.preventDefault()
    void submit()
    return
  }
  if (event.key === 'Escape' && replyToId.value) {
    event.preventDefault()
    event.stopPropagation()
    cancelReply()
    return
  }
  if (event.key === 'ArrowUp' && !draft.value && !event.shiftKey && editLastMessage()) event.preventDefault()
}

function onInput() {
  syncCaret()
  if (dismissedAt.value !== null && trigger.value?.start !== dismissedAt.value) dismissedAt.value = null
}

function insertEmoji(emoji: string) {
  const el = textarea()
  const text = draft.value || ''
  const start = el?.selectionStart ?? text.length
  const end = el?.selectionEnd ?? text.length
  draft.value = `${text.slice(0, start)}${emoji}${text.slice(end)}`
  emojiOpen.value = false
  const position = start + emoji.length
  nextTick(() => {
    const target = textarea()
    target?.focus()
    target?.setSelectionRange(position, position)
  })
}

// Typing while nothing else has focus goes to the composer, like Discord.
if (import.meta.client) {
  useEventListener(document, 'keydown', (event: KeyboardEvent) => {
    if (!props.primary || props.disabled || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key.length !== 1 || event.key === ' ') return
    const active = document.activeElement as HTMLElement | null
    if (active && (active.isContentEditable || active.closest('input, textarea, select, [role="dialog"], [role="menu"], [data-message-id]'))) return
    if (document.querySelector('[role="dialog"][data-state="open"]')) return
    focus()
  })
}

onMounted(() => {
  if (props.primary && !touchInput) nextTick(focus)
})

watch(() => ui.composerState(props.channelId).replyToId, (id) => {
  if (id) nextTick(focus)
})

/* ------------------------------------------------------------------ sending */

const length = computed(() => draft.value.length)
const overLimit = computed(() => length.value > MAX_LENGTH)

function restoreSubmission(channelId: string, submission: ComposerSubmission<File>) {
  const state = ui.composerState(channelId)
  if (!state.draft && !state.replyToId) {
    ui.setComposerDraft(channelId, submission.draft)
    if (submission.replyToId) ui.startReply(channelId, submission.replyToId)
  }
  if (props.channelId === channelId) files.value = [...submission.files, ...files.value].slice(0, MAX_FILES)
}

function removeOptimistic(channelId: string, clientId: string) {
  qc.setQueryData<InfiniteData<Page>>(['messages', channelId], old => old
    ? {
        ...old,
        pages: old.pages.map(page => ({
          ...page,
          messages: page.messages.filter(message => message.clientId !== clientId),
        })),
      }
    : old)
}

async function submit() {
  if (props.disabled || recording.value) return
  if (overLimit.value) {
    toast.add({ title: `Messages can be up to ${MAX_LENGTH} characters`, color: 'error' })
    return
  }
  if (files.value.length && attachmentsDisabled.value) {
    toast.add({ title: 'You cannot attach files in this channel', color: 'error' })
    return
  }
  const channelId = props.channelId
  const submission = claimComposerSubmission<File>({
    read: () => ({
      draft: draft.value,
      files: files.value,
      replyToId: replyToId.value,
    }),
    clear: () => {
      ui.clearComposer(channelId)
      files.value = []
    },
  })
  if (!submission) return

  const members = props.members.map((m) => ({ id: m.user.id, displayName: m.user.displayName, nickname: m.nickname }))
  const content = replaceShortcodes(applyMentionTokens(submission.draft, members)).trim()
  if (!content && !submission.files.length) return

  const clientId = newId()
  const replyTo = submission.replyToId ? cachedMessages().find(message => message.id === submission.replyToId) : undefined
  const optimistic: MessageDTO = {
    id: `tmp:${clientId}`,
    channelId,
    workspaceId: props.workspaceId,
    author: session.user!,
    content,
    replyTo: replyTo
      ? { id: replyTo.id, authorId: replyTo.author.id, content: replyTo.content.slice(0, 180), attachmentCount: replyTo.attachments.length, deleted: Boolean(replyTo.deletedAt) }
      : null,
    mentions: [],
    attachments: [],
    reactions: [],
    pin: null,
    threadId: null,
    editedAt: null,
    deletedAt: null,
    createdAt: nowIso(),
    clientId,
    deliveryState: submission.files.length ? 'uploading' : 'sending',
  }
  qc.setQueryData<InfiniteData<Page>>(['messages', channelId], (old) => {
    if (!old?.pages?.length) return { pages: [{ messages: [optimistic], nextCursor: null }], pageParams: [undefined] }
    const pages = old.pages.map((p, i) => i === 0 ? { ...p, messages: [...p.messages, optimistic] } : p)
    return { ...old, pages }
  })

  let attachmentIds: string[] = []
  try {
    // Uploads run in parallel; the ids keep the order the files were attached in.
    attachmentIds = await Promise.all(submission.files.map(async (file) => {
      const fd = new FormData()
      fd.append('file', file)
      const res = await api<{ attachment: { id: string } }>(`/api/channels/${channelId}/attachments`, {
        method: 'POST',
        body: fd,
      })
      return res.attachment.id
    }))
  }
  catch (err) {
    removeOptimistic(channelId, clientId)
    restoreSubmission(channelId, submission)
    toast.add({ title: errorMessage(err), color: 'error' })
    return
  }

  props.send({
    t: 'message.create',
    content,
    replyToId: submission.replyToId ?? undefined,
    clientId,
    attachmentIds: attachmentIds.length ? attachmentIds : undefined,
    agentMode: props.agentBusy ? agentMode.value : undefined,
  })
  agentMode.value = 'queue'
}

const typing = createTypingActivity(active => props.send({ t: 'typing', active }))

watch(draft, (value) => {
  if (!props.disabled && value) typing.input()
  else typing.stop()
})
watch(() => [props.channelId, props.disabled], () => {
  typing.stop()
  if (recording.value) cancelAudioRecording()
})
onUnmounted(() => typing.stop())

function cancelReply() {
  ui.composerState(props.channelId).replyToId = null
}

defineExpose({ addFiles, focus })
</script>

<template>
  <form class="relative px-4 pb-6 pt-2" @submit.prevent="submit">
    <div
      v-if="suggestions.length"
      class="absolute inset-x-4 bottom-full z-30 mb-1 overflow-hidden rounded-lg bg-default shadow-xl ring ring-default"
      role="listbox"
      :aria-label="trigger?.kind === 'emoji' ? 'Emoji matching' : 'Members matching'"
    >
      <p class="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
        {{ trigger?.kind === 'emoji' ? `Emoji matching :${trigger.query}` : 'Members' }}
      </p>
      <button
        v-for="(item, index) in suggestions"
        :key="item.key"
        type="button"
        role="option"
        :aria-selected="index === suggestionIndex"
        class="flex w-full items-center gap-2.5 px-3 py-1.5 text-start text-sm"
        :class="index === suggestionIndex ? 'bg-accented text-highlighted' : 'text-default'"
        @mouseenter="suggestionIndex = index"
        @mousedown.prevent="accept(item)"
      >
        <UserAvatar v-if="item.member" :user="item.member.user" size="2xs" />
        <span v-else-if="item.emoji" class="w-5 text-center text-lg leading-none">{{ item.emoji }}</span>
        <span class="truncate font-medium">{{ item.label }}</span>
        <span v-if="item.detail" class="truncate text-xs text-muted">{{ item.detail }}</span>
      </button>
    </div>
    <div
      class="df-composer overflow-hidden"
      :class="replyTarget ? 'rounded-b-lg' : 'rounded-lg'"
    >
      <div v-if="replyTarget" class="flex items-center gap-2 bg-muted px-3 py-2 text-sm text-muted">
        <span class="min-w-0 flex-1 truncate">Replying to <span class="font-semibold text-toned">{{ replyTarget.name }}</span></span>
        <UButton size="xs" color="neutral" variant="ghost" square icon="i-ph-x-circle-fill" aria-label="Cancel reply" @click="cancelReply" />
      </div>
      <AttachmentDraftPreview v-if="files.length" :files="files" @remove="removeFile" />
      <div class="flex min-h-11 items-end gap-0.5 px-2">
        <UTooltip text="Upload a file">
          <UButton
            icon="i-ph-plus"
            color="neutral"
            variant="ghost"
            size="sm"
            square
            class="composer-icon"
            :ui="{ leadingIcon: 'size-5' }"
            :disabled="attachmentsDisabled || recording"
            aria-label="Attach files"
            @click="() => openFiles()"
          />
        </UTooltip>
        <div v-if="recording" class="flex min-w-0 flex-1 items-center gap-2 self-stretch px-2" aria-live="polite">
          <span class="size-2 shrink-0 animate-pulse rounded-full bg-error" />
          <span class="truncate text-sm text-default">Recording</span>
          <time class="font-mono text-sm tabular-nums text-muted">{{ recordingTime }}</time>
          <UTooltip text="Cancel recording">
            <UButton
              icon="i-ph-x"
              color="neutral"
              variant="ghost"
              size="sm"
              square
              class="composer-icon ms-auto"
              :ui="{ leadingIcon: 'size-5' }"
              aria-label="Cancel recording"
              @click="cancelAudioRecording"
            />
          </UTooltip>
          <UTooltip text="Stop recording">
            <UButton
              icon="i-ph-stop"
              color="error"
              variant="soft"
              size="sm"
              square
              class="composer-icon danger"
              :ui="{ leadingIcon: 'size-5' }"
              aria-label="Stop recording"
              @click="stopAudioRecording"
            />
          </UTooltip>
        </div>
        <UTextarea
          v-else
          ref="field"
          v-model="draft"
          autoresize
          :rows="1"
          :maxrows="12"
          variant="none"
          color="neutral"
          class="flex-1 self-stretch"
          :ui="{ base: () => 'w-full bg-transparent px-1 py-2.5 text-base leading-snug text-default placeholder:text-muted resize-none focus:outline-none' }"
          :placeholder="disabled ? (disabledPlaceholder || 'You cannot send messages in this channel') : (placeholder || 'Message')"
          :disabled="disabled"
          :aria-autocomplete="'list'"
          :aria-expanded="suggestions.length > 0"
          @keydown="onKey"
          @input="onInput"
          @click="syncCaret"
          @keyup="syncCaret"
          @paste="onPaste"
          @blur="dismissedAt = null"
        />
        <span
          v-if="length > MAX_LENGTH - 200"
          class="mb-3 self-end text-xs tabular-nums"
          :class="overLimit ? 'text-error font-semibold' : 'text-muted'"
          :aria-label="`${MAX_LENGTH - length} characters left`"
        >{{ MAX_LENGTH - length }}</span>
        <UPopover v-if="!recording" v-model:open="emojiOpen" :content="{ side: 'top', align: 'end', sideOffset: 12 }">
          <UButton
            icon="i-ph-smiley"
            color="neutral"
            variant="ghost"
            size="sm"
            square
            class="composer-icon"
            :ui="{ leadingIcon: 'size-5' }"
            :disabled="disabled"
            aria-label="Emoji"
          />
          <template #content>
            <ChatEmojiPicker @select="insertEmoji" />
          </template>
        </UPopover>
        <UTooltip v-if="!recording" text="Record audio">
          <UButton
            icon="i-ph-microphone"
            color="neutral"
            variant="ghost"
            size="sm"
            square
            class="composer-icon"
            :ui="{ leadingIcon: 'size-5' }"
            :disabled="attachmentsDisabled"
            aria-label="Record audio"
            @click="recordAudio"
          />
        </UTooltip>
        <USelect
          v-if="!recording && agentBusy"
          v-model="agentMode"
          :items="agentModes"
          value-key="value"
          size="xs"
          variant="ghost"
          class="w-20 self-center"
          aria-label="Agent message mode"
        />
        <UTooltip v-if="!recording && (draft.trim() || files.length)" text="Send">
          <UButton
            type="submit"
            icon="i-ph-paper-plane-tilt"
            color="primary"
            variant="ghost"
            size="sm"
            square
            class="composer-icon accent"
            :ui="{ leadingIcon: 'size-5' }"
            :disabled="disabled || overLimit"
            aria-label="Send message"
          />
        </UTooltip>
      </div>
    </div>
  </form>
</template>

<style scoped>
/* One compact style for every composer icon: a tight square, a larger glyph,
   and a colour change on hover instead of a filled box. */
.composer-icon {
  margin-bottom: 0 !important;
  display: inline-flex;
  width: 2.25rem;
  height: 2.25rem;
  flex-shrink: 0;
  align-self: center;
  align-items: center;
  justify-content: center;
  padding: 0;
  background: transparent !important;
  color: var(--ui-text-muted);
}

.composer-icon:hover:not(:disabled) {
  color: var(--ui-text-highlighted);
}

.composer-icon.accent,
.composer-icon.accent:hover:not(:disabled) {
  color: var(--ui-primary);
}

.composer-icon.danger,
.composer-icon.danger:hover:not(:disabled) {
  color: var(--ui-error);
}

@media (min-width: 768px) {
  .composer-icon {
    width: 2rem;
    height: 2rem;
  }
}
</style>
