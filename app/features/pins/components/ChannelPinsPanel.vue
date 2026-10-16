<script setup lang="ts">
import { useQuery, useQueryClient, type InfiniteData } from '@tanstack/vue-query'
import type { MessageContextResponse, MessageDTO } from '~~/shared/types'
import { formatMessageTime } from '~~/shared/format'
import { mergeMessageContext, type MessagePage } from '~/utils/message-cache'

const props = defineProps<{
  channelId: string
  canPin?: boolean
}>()
const qc = useQueryClient()
const toast = useToast()
const { api } = useApi()

const pinsQ = useQuery({
  queryKey: computed(() => ['pins', props.channelId]),
  queryFn: () => api<{ messages: MessageDTO[] }>(`/api/channels/${props.channelId}/pins`),
  enabled: computed(() => Boolean(props.channelId)),
})

function summary(message: MessageDTO): string {
  if (message.content.trim()) return message.content
  if (message.attachments.length === 1) return message.attachments[0]?.filename ?? 'Attachment'
  if (message.attachments.length > 1) return `${message.attachments.length} attachments`
  return 'Message'
}

async function jump(messageId: string) {
  const existing = document.getElementById(`message-${messageId}`)
  if (existing) {
    existing.scrollIntoView({ block: 'center', behavior: 'smooth' })
    return
  }
  try {
    const context = await api<MessageContextResponse>(
      `/api/channels/${props.channelId}/messages/${messageId}/context`,
    )
    qc.setQueryData<InfiniteData<MessagePage>>(
      ['messages', props.channelId],
      current => mergeMessageContext(current, context),
    )
    await nextTick()
    requestAnimationFrame(() => {
      document.getElementById(`message-${messageId}`)?.scrollIntoView({ block: 'center' })
    })
  }
  catch {
    toast.add({ title: 'Could not open message', color: 'error' })
  }
}

async function unpin(messageId: string) {
  try {
    await api(`/api/messages/${messageId}/pin`, { method: 'DELETE' })
    await pinsQ.refetch()
  }
  catch {
    toast.add({ title: 'Could not unpin message', color: 'error' })
  }
}
</script>

<template>
  <div v-if="pinsQ.isPending.value" class="p-3">
    <LayoutSkeleton variant="cards" />
  </div>
  <LayoutLoadError v-else-if="pinsQ.error.value" message="Pinned messages did not load." :retry="pinsQ.refetch" />
  <div v-else-if="!pinsQ.data.value?.messages.length" class="px-4 py-10 text-center">
    <UIcon name="i-ph-push-pin" class="size-6 text-dimmed" />
    <p class="mt-2 text-sm font-medium text-highlighted">No pinned messages</p>
    <p class="mt-1 text-xs text-muted">Pin a message to keep it one tap away for everyone here.</p>
  </div>
  <ul v-else class="p-2">
    <li
      v-for="message in pinsQ.data.value?.messages"
      :key="message.id"
      class="group/pin flex items-start gap-1 rounded-md hover:bg-elevated"
    >
      <button
        type="button"
        class="min-w-0 flex flex-1 items-start gap-2 px-2 py-2 text-start"
        @click="jump(message.id)"
      >
        <UserAvatar :user="message.author" size="xs" />
        <span class="min-w-0 flex-1">
          <span class="flex items-center gap-1.5 text-xs">
            <strong class="truncate text-highlighted">{{ message.author.displayName }}</strong>
            <time class="shrink-0 text-muted" :datetime="message.createdAt">{{ formatMessageTime(message.createdAt) }}</time>
          </span>
          <span class="mt-0.5 block line-clamp-3 whitespace-pre-wrap text-sm text-default">{{ summary(message) }}</span>
          <span v-if="message.pin" class="mt-1 block truncate text-xs text-muted">
            Pinned by {{ message.pin.pinnedBy.displayName }} · {{ formatMessageTime(message.pin.pinnedAt) }}
          </span>
        </span>
      </button>
      <UTooltip v-if="canPin" text="Unpin message">
        <UButton
          class="mt-1 shrink-0 opacity-0 group-hover/pin:opacity-100 focus:opacity-100"
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-ph-x"
          aria-label="Unpin message"
          @click="unpin(message.id)"
        />
      </UTooltip>
    </li>
  </ul>
</template>
