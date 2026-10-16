<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import type { ChannelThreadDTO, MemberDTO, MessageDTO } from '~~/shared/types'
import { formatFullDateTime, formatMessageTime, formatTime } from '~~/shared/format'
import { emojiName, isJumboEmoji } from '~~/shared/emoji'
import AttachmentGallery from '~/features/attachments/components/AttachmentGallery.vue'

const props = defineProps<{
  message: MessageDTO
  thread?: ChannelThreadDTO
  names: Record<string, string>
  member?: MemberDTO
  mine: boolean
  canPin?: boolean
  /** Threads cannot hold threads, so their rows offer no thread action. */
  canThread?: boolean
  compact?: boolean
  streaming?: boolean
  /** The pointer or keyboard focus is on this row: only then is the toolbar rendered. */
  active?: boolean
  editing?: boolean
  highlighted?: boolean
  mentionsMe?: boolean
  actions?: DropdownMenuItem[][]
}>()
const emit = defineEmits<{
  reply: []
  edit: []
  remove: [immediate: boolean]
  thread: []
  jump: [id: string]
  react: [emoji: string]
  pin: []
  retry: []
  saveEdit: []
  cancelEdit: []
  longpress: []
}>()

const prefs = usePrefsStore()
const ui = useUiStore()
const shift = useShiftHeld()
const editDraft = computed({
  get: () => ui.composerState(props.message.channelId).editDraft,
  set: value => ui.setEditDraft(props.message.channelId, value),
})

const actionable = computed(() => !props.message.deletedAt && !props.message.id.startsWith('tmp:'))
const quickEmoji = computed(() => {
  const recent = Array.isArray(prefs.recentEmoji) ? prefs.recentEmoji : []
  return [...new Set([...recent, '👍', '❤️', '😂'])].slice(0, 3)
})
const jumbo = computed(() => isJumboEmoji(props.message.content))
const pickerOpen = ref(false)
const reactionPickerOpen = ref(false)
const moreOpen = ref(false)
const profileOpen = ref(false)
const nameProfileOpen = ref(false)
const toolbarVisible = computed(() => actionable.value && !props.editing
  && (props.active || pickerOpen.value || moreOpen.value))

// Phones cannot hover, so a long press opens the message's actions in a sheet.
let pressTimer: ReturnType<typeof setTimeout> | undefined
let pressStart: { x: number, y: number } | null = null

function onTouchStart(event: TouchEvent) {
  if (!actionable.value || props.editing || event.touches.length !== 1) return
  const target = event.target as Element | null
  if (target?.closest('a, button, video, audio, input, textarea, .spoiler')) return
  const touch = event.touches[0]!
  pressStart = { x: touch.clientX, y: touch.clientY }
  clearTimeout(pressTimer)
  pressTimer = setTimeout(() => {
    pressStart = null
    emit('longpress')
    navigator.vibrate?.(10)
  }, 450)
}

function onTouchMove(event: TouchEvent) {
  if (!pressStart) return
  const touch = event.touches[0]!
  if (Math.hypot(touch.clientX - pressStart.x, touch.clientY - pressStart.y) > 10) cancelPress()
}

function cancelPress() {
  clearTimeout(pressTimer)
  pressStart = null
}

onBeforeUnmount(cancelPress)

function react(emoji: string) {
  pickerOpen.value = false
  reactionPickerOpen.value = false
  prefs.useEmoji(emoji)
  emit('react', emoji)
}

function replySummary(reply: NonNullable<MessageDTO['replyTo']>) {
  if (reply.deleted) return 'Original message was deleted'
  if (reply.content.trim()) return reply.content
  if (reply.attachmentCount === 1) return 'Attachment'
  if (reply.attachmentCount > 1) return `${reply.attachmentCount} attachments`
  return 'Message'
}

function reactionLabel(emoji: string, count: number, me: boolean) {
  const name = emojiName(emoji)
  const who = me ? (count > 1 ? `You and ${count - 1} other${count > 2 ? 's' : ''}` : 'You') : `${count} ${count === 1 ? 'person' : 'people'}`
  return `${who} reacted with ${name ? `:${name}:` : emoji}`
}
</script>

<template>
  <article
    :data-message-id="message.id"
    tabindex="-1"
    class="message-row group relative pe-12 ps-4 focus-visible:outline-none"
    :class="[
      compact ? 'py-0.5' : 'mt-[1.0625rem] py-0.5',
      mentionsMe ? 'bg-warning/8 hover:bg-warning/12 before:absolute before:inset-y-0 before:start-0 before:w-0.5 before:bg-warning' : 'hover:bg-elevated/40 focus-within:bg-elevated/40',
      highlighted ? 'bg-primary/10' : '',
      editing ? 'bg-elevated/40' : '',
    ]"
    @touchstart.passive="onTouchStart"
    @touchmove.passive="onTouchMove"
    @touchend.passive="cancelPress"
    @touchcancel.passive="cancelPress"
  >
    <button
      v-if="message.replyTo"
      type="button"
      class="reply-spine relative ms-14 mb-0.5 flex w-fit max-w-[calc(100%-3.5rem)] items-center gap-1.5 rounded py-0.5 text-[13px] leading-4 text-muted hover:text-default"
      :aria-label="`Jump to reply from ${names[message.replyTo.authorId] || 'member'}`"
      @click="emit('jump', message.replyTo.id)"
    >
      <span class="shrink-0 font-semibold text-toned">@{{ names[message.replyTo.authorId] || 'member' }}</span>
      <UIcon v-if="!message.replyTo.deleted && !message.replyTo.content.trim() && message.replyTo.attachmentCount" name="i-ph-image" class="size-3.5 shrink-0" />
      <span class="truncate" :class="message.replyTo.deleted ? 'italic' : ''">{{ replySummary(message.replyTo) }}</span>
    </button>
    <div class="flex gap-4">
    <div class="w-10 shrink-0 flex justify-center">
      <UPopover v-if="!compact" v-model:open="profileOpen" :content="{ side: 'right', align: 'start', sideOffset: 8 }" :ui="{ content: 'overflow-hidden' }">
        <button type="button" class="mt-0.5 h-fit rounded-full" :aria-label="`View ${message.author.displayName}'s profile`">
          <UserAvatar :user="message.author" size="md" />
        </button>
        <template #content>
          <ChatUserCard :user="message.author" :member="member" @close="profileOpen = false" />
        </template>
      </UPopover>
      <time
        v-else
        class="text-[10px] text-muted leading-[1.375rem] opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 tabular-nums"
        :datetime="message.createdAt"
        :title="formatFullDateTime(message.createdAt)"
      >{{ formatTime(message.createdAt) }}</time>
    </div>
    <div class="min-w-0 flex-1">
      <div v-if="!compact" class="flex items-baseline gap-2 leading-[1.375rem]">
        <UPopover v-model:open="nameProfileOpen" :content="{ side: 'right', align: 'start', sideOffset: 8 }" :ui="{ content: 'overflow-hidden' }">
          <button type="button" class="font-medium text-highlighted hover:underline">
            {{ member?.nickname || message.author.displayName }}
          </button>
          <template #content>
            <ChatUserCard :user="message.author" :member="member" @close="nameProfileOpen = false" />
          </template>
        </UPopover>
        <UBadge v-if="message.author.kind === 'agent'" label="AI" size="sm" color="primary" variant="subtle" class="self-center px-1 py-0 text-[10px]" />
        <time class="text-xs text-muted" :datetime="message.createdAt" :title="formatFullDateTime(message.createdAt)">{{ formatMessageTime(message.createdAt) }}</time>
      </div>
      <p v-if="message.deletedAt" class="text-muted italic">Message deleted</p>
      <ChatMessageEditor
        v-else-if="editing"
        v-model="editDraft"
        @save="emit('saveEdit')"
        @cancel="emit('cancelEdit')"
      />
      <div
        v-else
        class="message-body leading-[1.375rem] transition-opacity"
        :class="[jumbo ? 'jumbo' : '', message.deliveryState === 'sending' || message.deliveryState === 'uploading' ? 'opacity-50' : '']"
        :aria-busy="message.deliveryState === 'sending' || undefined"
      >
        <ChatMarkdownView :content="message.content" :names="names" />
        <span v-if="streaming" class="inline-block h-4 w-0.5 animate-pulse bg-primary align-text-bottom" aria-label="Streaming" />
        <span v-if="message.editedAt" class="ms-1 select-none text-[10px] text-muted" :title="formatFullDateTime(message.editedAt)">(edited)</span>
      </div>
      <AttachmentGallery v-if="message.attachments.length" :attachments="message.attachments" />
      <!-- A message on its way is only dimmed, as in Discord; uploads say so because they can take a while. -->
      <div v-if="message.deliveryState && message.deliveryState !== 'sending'" class="mt-0.5 flex h-5 items-center gap-1.5 text-xs" aria-live="polite">
        <template v-if="message.deliveryState === 'uploading'">
          <UIcon name="i-ph-circle-notch" class="size-3 animate-spin text-muted" />
          <span class="text-muted">Uploading…</span>
        </template>
        <template v-else>
          <UIcon name="i-ph-warning-circle" class="size-3.5 text-error" />
          <span class="text-error">Not sent.</span>
          <UButton
            size="xs"
            color="error"
            variant="link"
            label="Retry"
            class="px-0"
            @click="emit('retry')"
          />
        </template>
      </div>
      <div v-if="message.reactions?.length" class="mt-1 flex flex-wrap items-center gap-1">
        <UTooltip v-for="r in message.reactions" :key="r.emoji" :text="reactionLabel(r.emoji, r.count, r.me)" :delay-duration="300">
          <button
            type="button"
            class="flex h-6 items-center gap-1.5 rounded-md border px-1.5 text-sm transition-colors"
            :class="r.me ? 'border-primary/60 bg-primary/15 text-highlighted' : 'border-transparent bg-elevated text-toned hover:border-accented'"
            :aria-pressed="r.me"
            :aria-label="reactionLabel(r.emoji, r.count, r.me)"
            @click="react(r.emoji)"
          >
            <span class="text-base leading-none">{{ r.emoji }}</span>
            <span class="text-xs font-semibold tabular-nums">{{ r.count }}</span>
          </button>
        </UTooltip>
        <UPopover v-if="actionable" v-model:open="reactionPickerOpen">
          <button
            type="button"
            class="flex h-6 items-center rounded-md bg-elevated px-1.5 text-muted opacity-0 transition-opacity hover:text-default group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
            :class="reactionPickerOpen ? 'opacity-100' : ''"
            aria-label="Add reaction"
          >
            <UIcon name="i-ph-smiley-sticker" class="size-4" />
          </button>
          <template #content>
            <ChatEmojiPicker @select="react" />
          </template>
        </UPopover>
      </div>
      <div v-if="message.threadId" class="relative mt-1 max-w-xl ps-6">
        <!-- Connector: drops from under the message and curves into the card's middle. -->
        <span
          class="pointer-events-none absolute start-1.5 top-1 h-[calc(50%-0.25rem)] w-4.5 rounded-es-[10px] border-s-2 border-b-2 border-accented"
          aria-hidden="true"
        />
        <button
          type="button"
          class="group/thread flex w-full items-center gap-3 rounded-md border border-default bg-elevated px-3 py-2 text-start transition-colors hover:border-accented hover:bg-accented/60"
          @click="emit('thread')"
        >
          <span class="flex size-8 shrink-0 items-center justify-center rounded-full bg-accented text-primary">
            <UIcon name="i-ph-chats-circle" class="size-5" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm font-medium text-highlighted">{{ thread?.title || 'Thread' }}</span>
            <span class="mt-0.5 flex items-center gap-1.5 text-xs">
              <span class="font-semibold text-primary">
                {{ thread ? `${thread.replyCount} ${thread.replyCount === 1 ? 'reply' : 'replies'}` : 'Open thread' }}
              </span>
              <span v-if="thread?.lastReplyAt" class="truncate text-muted">Last reply {{ formatMessageTime(thread.lastReplyAt) }}</span>
            </span>
          </span>
          <UIcon name="i-ph-caret-right" class="size-4 shrink-0 text-muted transition-transform group-hover/thread:translate-x-0.5" />
        </button>
      </div>
    </div>
    </div>
    <!-- Rendered only for the active row: hundreds of hidden toolbars made long channels slow. -->
    <div
      v-if="toolbarVisible"
      class="absolute right-4 -top-4 z-10 flex items-center rounded-md bg-default p-0.5 shadow-sm ring ring-default pointer-coarse:hidden"
      role="toolbar"
      :aria-label="`Actions for message from ${message.author.displayName}`"
    >
      <template v-if="!shift">
        <UButton
          v-for="e in quickEmoji"
          :key="e"
          size="sm"
          variant="ghost"
          color="neutral"
          class="size-8 justify-center p-0 text-lg"
          :label="e"
          :aria-label="`React with ${e}`"
          @click="react(e)"
        />
        <USeparator orientation="vertical" class="mx-0.5 h-5" />
      </template>
      <UPopover v-model:open="pickerOpen">
        <UTooltip text="Add reaction" :content="{ side: 'top' }">
          <UButton size="sm" variant="ghost" color="neutral" square icon="i-ph-smiley-sticker" aria-label="Add reaction" />
        </UTooltip>
        <template #content>
          <ChatEmojiPicker @select="react" />
        </template>
      </UPopover>
      <UTooltip v-if="mine" text="Edit" :content="{ side: 'top' }">
        <UButton size="sm" variant="ghost" color="neutral" square icon="i-ph-pencil-simple" aria-label="Edit" @click="emit('edit')" />
      </UTooltip>
      <UTooltip text="Reply" :content="{ side: 'top' }">
        <UButton size="sm" variant="ghost" color="neutral" square icon="i-ph-arrow-bend-up-left" aria-label="Reply" @click="emit('reply')" />
      </UTooltip>
      <UTooltip v-if="canThread" :text="message.threadId ? 'Open thread' : 'Create thread'" :content="{ side: 'top' }">
        <UButton
          size="sm"
          variant="ghost"
          color="neutral"
          square
          icon="i-ph-chats"
          :aria-label="message.threadId ? 'Open thread' : 'Create thread'"
          @click="emit('thread')"
        />
      </UTooltip>
      <template v-if="shift">
        <UTooltip v-if="canPin" :text="message.pin ? 'Unpin message' : 'Pin message'" :content="{ side: 'top' }">
          <UButton
            size="sm"
            :variant="message.pin ? 'soft' : 'ghost'"
            :color="message.pin ? 'primary' : 'neutral'"
            square
            icon="i-ph-push-pin"
            :aria-label="message.pin ? 'Unpin message' : 'Pin message'"
            @click="emit('pin')"
          />
        </UTooltip>
        <UTooltip v-if="mine" text="Delete without confirmation" :content="{ side: 'top' }">
          <UButton size="sm" variant="ghost" color="error" square icon="i-ph-trash" aria-label="Delete now" @click="emit('remove', true)" />
        </UTooltip>
      </template>
      <UDropdownMenu v-else-if="actions?.length" v-model:open="moreOpen" :items="actions" :content="{ align: 'end' }">
        <UButton size="sm" variant="ghost" color="neutral" square icon="i-ph-dots-three" aria-label="More" />
      </UDropdownMenu>
    </div>
  </article>
</template>

<style scoped>
/* On touch screens a long press opens the action sheet; keep the system callout
   and text selection from competing with it (the sheet offers Copy text). */
@media (pointer: coarse) {
  .message-row {
    -webkit-touch-callout: none;
    user-select: none;
  }
}

/* Discord-style curved connector from a reply's preview to its avatar. */
.reply-spine::before {
  content: "";
  position: absolute;
  inset-inline-start: -2.25rem;
  top: 50%;
  width: 2rem;
  height: 0.8rem;
  border-inline-start: 2px solid var(--ui-border-accented);
  border-top: 2px solid var(--ui-border-accented);
  border-start-start-radius: 6px;
  pointer-events: none;
}

/* "(edited)" and the streaming caret follow the last line of text, as in Discord. */
.message-body > :deep(.md),
.message-body > :deep(.md > p:last-child) {
  display: inline;
}

.jumbo :deep(.md) {
  font-size: 3rem;
  line-height: 1.2;
}
</style>
