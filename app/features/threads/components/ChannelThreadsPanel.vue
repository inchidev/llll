<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { ChannelThreadDTO } from '~~/shared/types'
import { formatMessageTime } from '~~/shared/format'

const props = defineProps<{
  channelId: string
}>()
const ui = useUiStore()
const { api } = useApi()

const threadsQ = useQuery({
  queryKey: computed(() => ['threads', props.channelId]),
  queryFn: () => api<{ threads: ChannelThreadDTO[] }>(`/api/channels/${props.channelId}/threads`),
  enabled: computed(() => Boolean(props.channelId)),
})

function openThread(thread: ChannelThreadDTO) {
  ui.threadId = thread.id
  ui.threadParentId = props.channelId
  ui.rightPanelOpen = true
  ui.rightPanelTab = 'threads'
}
</script>

<template>
  <div v-if="threadsQ.isPending.value" class="p-3">
    <LayoutSkeleton variant="cards" />
  </div>
  <LayoutLoadError v-else-if="threadsQ.error.value" message="Threads did not load." :retry="threadsQ.refetch" />
  <div v-else-if="!threadsQ.data.value?.threads.length" class="px-4 py-10 text-center">
    <UIcon name="i-ph-chats" class="size-6 text-dimmed" />
    <p class="mt-2 text-sm font-medium text-highlighted">No threads yet</p>
    <p class="mt-1 text-xs text-muted">Start one from any message to keep a side conversation together.</p>
  </div>
  <div v-else class="p-2">
    <button
      v-for="thread in threadsQ.data.value?.threads"
      :key="thread.id"
      type="button"
      class="flex w-full items-start gap-2 rounded-md px-2 py-2 text-start hover:bg-elevated"
      @click="openThread(thread)"
    >
      <UserAvatar :user="thread.author" size="xs" />
      <span class="min-w-0 flex-1">
        <span class="block truncate text-sm font-medium text-highlighted">{{ thread.title }}</span>
        <!-- One line that truncates, so a narrow panel never splits it into columns. -->
        <span class="mt-0.5 block truncate text-xs text-muted">
          <span class="font-medium text-primary">{{ thread.replyCount }} {{ thread.replyCount === 1 ? 'reply' : 'replies' }}</span>
          · {{ thread.author.displayName }}<template v-if="thread.lastReplyAt"> · {{ formatMessageTime(thread.lastReplyAt) }}</template>
        </span>
      </span>
    </button>
  </div>
</template>
