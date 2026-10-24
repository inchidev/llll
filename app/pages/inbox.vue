<script setup lang="ts">
import { channelPath } from '~~/shared/paths'
import { conversationTitle, isAgentChat, inboxFilter, matchesInboxFilter } from '~~/shared/inbox'

definePageMeta({ layout: 'server', middleware: ['auth'] })
const { serverId } = useServer()
const session = useSessionStore()
const { unreadConversations, pending, error, channelError, dmError, retryFailed, refresh } = useInbox(() => serverId.value || '')
const loadError = computed(() => channelError.value && dmError.value ? 'Channels and direct messages did not load. Retry to see your full inbox.' : channelError.value ? 'Channels did not load. Your loaded direct messages are shown below.' : 'Direct messages did not load. Your loaded channels are shown below.')
const route = useRoute()
const filter = computed(() => inboxFilter(route.query.filter))
const filterLabel = computed(() => ({ all: 'Unread conversations', channels: 'Unread channels', direct: 'Unread direct messages', agents: 'Unread agent chats' })[filter.value])
const filtered = computed(() => unreadConversations.value.filter(channel => matchesInboxFilter(channel, filter.value)))
const warm = useMessagePrefetch()
const groups = computed(() => [
  { label: 'Channels', icon: 'i-ph-hash', channels: filtered.value.filter(channel => channel.type !== 'dm') },
  { label: 'Direct messages', icon: 'i-ph-chat-circle', channels: filtered.value.filter(channel => channel.type === 'dm' && !isAgentChat(channel)) },
  { label: 'Agent chats', icon: 'i-ph-robot', channels: filtered.value.filter(isAgentChat) },
].filter(group => group.channels.length))
</script>

<template>
  <div class="flex h-full min-h-0 min-w-0 flex-col">
    <LayoutPageHeader title="Inbox" icon="i-ph-tray">
      <template #meta><span v-if="!pending && !error" class="text-xs tabular-nums text-muted">{{ filtered.length }} {{ filtered.length === 1 ? 'conversation' : 'conversations' }}</span></template>
      <template #actions><UButton icon="i-ph-arrow-clockwise" color="neutral" variant="ghost" aria-label="Refresh inbox" :loading="pending" @click="refresh" /></template>
    </LayoutPageHeader>
    <main class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto max-w-3xl px-4 py-6 sm:px-8 sm:py-10">
        <h2 class="text-xl font-semibold text-highlighted">{{ filterLabel }}</h2>
        <p class="mt-1 text-sm text-muted">Catch up on channels, replies and messages in this Server.</p>
        <LayoutLoadError v-if="error" class="mt-6" :message="loadError" :retry="retryFailed" />
        <LayoutSkeleton v-if="pending && !unreadConversations.length" variant="nav" class="mt-6" :rows="5" />
        <LayoutEmptyState v-else-if="!pending && !error && !unreadConversations.length" icon="i-ph-check-circle" title="You're all caught up" description="New unread conversations will appear here.">
          <UButton to="/channels" color="neutral" variant="outline" label="Browse channels" />
        </LayoutEmptyState>
        <LayoutEmptyState v-else-if="!pending && !error && !filtered.length" icon="i-ph-tray" title="No unread conversations here" description="Other kinds of unread conversations may still be in your inbox."><UButton to="/inbox" color="neutral" variant="outline" label="All unread" /></LayoutEmptyState>
        <div v-else-if="filtered.length" class="mt-8 space-y-8">
          <section v-for="group in groups" :key="group.label">
            <h3 class="mb-2 text-xs font-medium text-muted">{{ group.label }}</h3>
            <ul class="divide-y divide-default">
              <li v-for="channel in group.channels" :key="channel.id">
                <NuxtLink :to="channelPath(channel)" :title="conversationTitle(channel, session.user?.id || '')" class="flex min-h-16 items-center gap-3 rounded-md px-2 py-3 hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary" @pointerenter="warm.intent(channel.id)" @pointerleave="warm.cancel()" @focus="warm.prefetch(channel.id)">
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
