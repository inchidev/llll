<script setup lang="ts">
import { channelPath } from '~~/shared/paths'
import { conversationTitle, isAgentChat } from '~~/shared/inbox'

definePageMeta({ layout: 'server', middleware: ['auth'] })
const { serverId } = useServer()
const session = useSessionStore()
const { unreadConversations, pending, error, refresh } = useInbox(() => serverId.value || '')
const warm = useMessagePrefetch()
const groups = computed(() => [
  { label: 'Channels', icon: 'i-ph-hash', channels: unreadConversations.value.filter(channel => channel.type !== 'dm') },
  { label: 'Direct messages', icon: 'i-ph-chat-circle', channels: unreadConversations.value.filter(channel => channel.type === 'dm' && !isAgentChat(channel)) },
  { label: 'Agent chats', icon: 'i-ph-robot', channels: unreadConversations.value.filter(isAgentChat) },
].filter(group => group.channels.length))
</script>

<template>
  <div class="flex h-full min-h-0 min-w-0 flex-col">
    <LayoutPageHeader title="Inbox" icon="i-ph-tray">
      <template #meta><span v-if="!pending && !error" class="text-xs tabular-nums text-muted">{{ unreadConversations.length }} unread</span></template>
      <template #actions><UButton icon="i-ph-arrow-clockwise" color="neutral" variant="ghost" aria-label="Refresh inbox" :loading="pending" @click="refresh" /></template>
    </LayoutPageHeader>
    <main class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto max-w-3xl px-4 py-6 sm:px-8 sm:py-10">
        <h2 class="text-xl font-semibold text-highlighted">Unread conversations</h2>
        <p class="mt-1 text-sm text-muted">Catch up on channels, replies and messages in this Server.</p>
        <LayoutSkeleton v-if="pending" variant="nav" class="mt-6" :rows="5" />
        <LayoutLoadError v-else-if="error" class="mt-6" message="Some conversations did not load. Refresh to see your full inbox." :retry="refresh" />
        <LayoutEmptyState v-else-if="!unreadConversations.length" icon="i-ph-check-circle" title="You're all caught up" description="New unread conversations will appear here.">
          <UButton to="/channels" color="neutral" variant="outline" label="Browse channels" />
        </LayoutEmptyState>
        <div v-else class="mt-8 space-y-8">
          <section v-for="group in groups" :key="group.label">
            <h3 class="mb-2 text-xs font-medium text-muted">{{ group.label }}</h3>
            <ul class="divide-y divide-default">
              <li v-for="channel in group.channels" :key="channel.id">
                <NuxtLink :to="channelPath(channel)" class="flex min-h-16 items-center gap-3 rounded-md px-2 py-3 hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary" @pointerenter="warm.intent(channel.id)" @pointerleave="warm.cancel()" @focus="warm.prefetch(channel.id)">
                  <UIcon :name="group.icon" class="size-5 shrink-0 text-muted" />
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-sm font-medium text-highlighted">{{ conversationTitle(channel, session.user?.id || '') }}</p>
                    <p class="mt-0.5 text-xs text-muted">{{ channel.type === 'dm' ? 'New messages' : 'New messages and replies' }}</p>
                  </div>
                  <UBadge color="neutral" variant="subtle" :label="channel.unreadCount ? `${channel.unreadCount > 99 ? '99+' : channel.unreadCount} unread` : 'Unread'" />
                  <UIcon name="i-ph-caret-right" class="size-4 shrink-0 text-muted" />
                </NuxtLink>
              </li>
            </ul>
          </section>
        </div>
      </div>
    </main>
  </div>
</template>
