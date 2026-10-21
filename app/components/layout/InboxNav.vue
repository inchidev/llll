<script setup lang="ts">
import { inboxFilter, matchesInboxFilter, type InboxFilter } from '~~/shared/inbox'
const props = defineProps<{ serverId: string }>()
const route = useRoute()
const { unreadConversations } = useInbox(() => props.serverId)
const filters: Array<{ value: InboxFilter; label: string; icon: string }> = [
  { value: 'all', label: 'All unread', icon: 'i-ph-tray' },
  { value: 'channels', label: 'Channels', icon: 'i-ph-hash' },
  { value: 'direct', label: 'Direct messages', icon: 'i-ph-chat-circle' },
  { value: 'agents', label: 'Agent chats', icon: 'i-ph-robot' },
]
</script>

<template>
  <nav aria-label="Inbox filters" class="px-2">
    <LayoutNavRow v-for="filter in filters" :key="filter.value" :to="filter.value === 'all' ? '/inbox' : `/inbox?filter=${filter.value}`" :active="inboxFilter(route.query.filter) === filter.value">
      <template #leading><UIcon :name="filter.icon" class="size-[18px] text-muted" /></template>
      {{ filter.label }}
      <template #trailing><span class="text-xs tabular-nums text-muted">{{ unreadConversations.filter(channel => matchesInboxFilter(channel, filter.value)).length }}</span></template>
    </LayoutNavRow>
  </nav>
</template>
