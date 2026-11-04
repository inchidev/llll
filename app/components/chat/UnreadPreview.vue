<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { ChannelDTO, MessageDTO } from '~~/shared/types'
import { channelPath } from '~~/shared/paths'
import { notificationPreview } from '~~/shared/notifications'
const props = defineProps<{ channel: ChannelDTO }>()
const { api } = useApi()
const query = useQuery({
  queryKey: computed(() => ['unread-preview', props.channel.id]),
  queryFn: () => api<{ messages: MessageDTO[] }>(`/api/channels/${props.channel.id}/unread-preview`),
  staleTime: 0,
})
</script>

<template>
  <div class="pb-3 pl-10 pr-2">
    <LayoutLoadError v-if="query.error.value" inline message="Preview did not load." :retry="query.refetch" />
    <LayoutSkeleton v-else-if="query.isPending.value" variant="nav" :rows="2" />
    <p v-else-if="!query.data.value?.messages.length" class="text-xs text-muted">No unread messages.</p>
    <template v-else>
      <p class="mb-2 text-xs text-muted">Latest unread messages · previewing does not mark them as read</p>
      <NuxtLink v-for="message in query.data.value?.messages" :key="message.id" :to="`${channelPath(channel, message.channelId === channel.id ? undefined : message.channelId)}?message=${message.id}`" class="mb-1 block rounded-md px-2 py-1.5 hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary">
        <span class="text-xs font-medium">{{ message.author.displayName }}</span>
        <span v-if="message.channelId !== channel.id" class="ml-2 text-xs text-muted">in a thread</span>
        <p class="line-clamp-2 text-sm text-muted">{{ notificationPreview(message.content, message.attachments.length) }}</p>
      </NuxtLink>
    </template>
  </div>
</template>
