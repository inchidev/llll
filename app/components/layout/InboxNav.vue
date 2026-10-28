<script setup lang="ts">
import { inboxSection, type InboxSection } from '~~/shared/inbox'
const props = defineProps<{ serverId: string }>()
const route = useRoute()
const { inbox, unreadConversations, unreadMailboxes } = useInbox(() => props.serverId)
const sections = computed<Array<{ value: InboxSection; label: string; icon: string; count: number }>>(() => [
  { value: 'all', label: 'Everything', icon: 'i-ph-tray', count: 0 },
  { value: 'approvals', label: 'Approvals', icon: 'i-ph-shield-check', count: inbox.value?.approvals.length ?? 0 },
  { value: 'mentions', label: 'Mentions', icon: 'i-ph-at', count: inbox.value?.mentions.length ?? 0 },
  { value: 'agents', label: 'Agent work', icon: 'i-ph-robot', count: inbox.value?.runs.filter(run => run.status === 'queued' || run.status === 'running').length ?? 0 },
  { value: 'tasks', label: 'My tasks', icon: 'i-ph-kanban', count: (inbox.value?.assigned.length ?? 0) + (inbox.value?.review.length ?? 0) },
  { value: 'mail', label: 'Mail', icon: 'i-ph-envelope-simple', count: unreadMailboxes.value.reduce((sum, mailbox) => sum + mailbox.unreadCount, 0) },
  { value: 'chats', label: 'Unread chats', icon: 'i-ph-chat-circle', count: unreadConversations.value.length },
])
</script>

<template>
  <nav aria-label="Inbox sections" class="px-2">
    <LayoutNavRow v-for="section in sections" :key="section.value" :to="section.value === 'all' ? '/inbox' : `/inbox?section=${section.value}`" :active="inboxSection(route.query.section) === section.value">
      <template #leading><UIcon :name="section.icon" class="size-[18px] text-muted" /></template>
      {{ section.label }}
      <template #trailing><span v-if="section.count" class="text-xs tabular-nums text-muted">{{ section.count }}</span></template>
    </LayoutNavRow>
  </nav>
</template>
