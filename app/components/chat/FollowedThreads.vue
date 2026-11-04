<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { FollowedThread } from '~~/shared/chat-attention'
import { formatMessageTime } from '~~/shared/format'
const props = defineProps<{ serverId: string }>()
const { api } = useApi()
const query = useQuery({
  queryKey: computed(() => ['followed-threads', props.serverId]),
  queryFn: () => api<{ threads: FollowedThread[] }>(`/api/servers/${props.serverId}/followed-threads`),
  enabled: computed(() => Boolean(props.serverId)),
})
</script>

<template>
  <section aria-label="My threads" class="mt-6">
    <p class="mb-4 text-sm text-muted">Threads you follow in this Space. Open a thread and choose Follow to keep it here.</p>
    <LayoutLoadError v-if="query.error.value" message="Your threads did not load." :retry="query.refetch" />
    <LayoutSkeleton v-else-if="query.isPending.value" variant="nav" :rows="4" />
    <LayoutEmptyState v-else-if="!query.data.value?.threads.length" icon="i-ph-chats" title="No followed threads" description="Following is separate from reading. Choose the discussions you want to keep up with." />
    <ul v-else class="divide-y divide-default">
      <li v-for="thread in query.data.value?.threads" :key="thread.id" class="py-2">
        <NuxtLink :to="thread.path" class="flex items-start gap-3 rounded-md px-2 py-2 hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary">
          <UIcon name="i-ph-chats" class="mt-0.5 size-5 shrink-0" :class="thread.unreadCount ? 'text-primary' : 'text-muted'" />
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium text-highlighted">{{ thread.title }}</p>
            <p class="mt-0.5 truncate text-xs text-muted">{{ thread.conversation || 'Direct message' }} · {{ formatMessageTime(thread.lastMessageAt) }}</p>
            <p v-if="thread.excerpt" class="mt-1 line-clamp-2 text-sm text-muted">{{ thread.excerpt }}</p>
          </div>
          <UBadge v-if="thread.unreadCount" :label="`${thread.unreadCount > 99 ? '99+' : thread.unreadCount} new`" variant="subtle" />
        </NuxtLink>
        <div class="flex justify-end"><ChatAttentionControls :channel-id="thread.id" thread /></div>
      </li>
    </ul>
  </section>
</template>
