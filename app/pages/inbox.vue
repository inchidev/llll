<script setup lang="ts">
import { channelPath, mailPath } from '~~/shared/paths'
import { formatMessageTime } from '~~/shared/format'
import { conversationTitle, inboxSection, isAgentChat, type InboxApprovalDTO, type InboxRunDTO, type InboxTaskDTO } from '~~/shared/inbox'

definePageMeta({ layout: 'server', middleware: ['auth'] })
const { serverId } = useServer()
const session = useSessionStore()
const route = useRoute()
const { inbox, unreadConversations, unreadMailboxes, pending, error, retryFailed, refresh } = useInbox(() => serverId.value || '')
const section = computed(() => inboxSection(route.query.section))
const shows = (name: string) => section.value === 'all' || section.value === name
const warm = useMessagePrefetch()

const operations: Record<string, string> = {
  bootstrap: 'set up its workspace', exec: 'run a command', read: 'read a file', write: 'edit a file',
  snapshot: 'save a snapshot', publish: 'open a pull request', suspend: 'pause its workspace', release: 'release its workspace', share: 'share its result',
}
const approvalText = (approval: InboxApprovalDTO) => `${approval.agentName} wants to ${operations[approval.operation] ?? 'take an action'}`
const activeRuns = computed(() => inbox.value?.runs.filter(run => run.status === 'queued' || run.status === 'running') ?? [])
const finishedRuns = computed(() => inbox.value?.runs.filter(run => run.status !== 'queued' && run.status !== 'running') ?? [])
const runState: Record<InboxRunDTO['status'], { label: string; icon: string; color: string }> = {
  queued: { label: 'Queued', icon: 'i-ph-clock', color: 'text-muted' },
  running: { label: 'Working', icon: 'i-ph-spinner-gap', color: 'text-primary' },
  completed: { label: 'Finished', icon: 'i-ph-check-circle', color: 'text-primary' },
  failed: { label: 'Failed', icon: 'i-ph-warning-circle', color: 'text-error' },
  cancelled: { label: 'Stopped', icon: 'i-ph-x-circle', color: 'text-muted' },
}
const taskMeta = (task: InboxTaskDTO) => [task.boardName, task.dueAt ? `Due ${formatMessageTime(task.dueAt)}` : '', task.priority === 'high' || task.priority === 'urgent' ? task.priority[0]!.toUpperCase() + task.priority.slice(1) : ''].filter(Boolean).join(' · ')
const chatIcon = (channel: (typeof unreadConversations.value)[number]) => isAgentChat(channel) ? 'i-ph-robot' : channel.type === 'dm' ? 'i-ph-chat-circle' : 'i-ph-hash'

const counts = computed(() => ({
  approvals: inbox.value?.approvals.length ?? 0,
  mentions: inbox.value?.mentions.length ?? 0,
  agents: inbox.value?.runs.length ?? 0,
  tasks: (inbox.value?.assigned.length ?? 0) + (inbox.value?.review.length ?? 0),
  mail: unreadMailboxes.value.length,
  chats: unreadConversations.value.length,
}))
const empty = computed(() => section.value === 'all' ? Object.values(counts.value).every(count => !count) : !counts.value[section.value])
const titles: Record<string, string> = { all: 'Needs you', approvals: 'Approvals', mentions: 'Mentions', agents: 'Agent work', tasks: 'My tasks', mail: 'Mail', chats: 'Unread chats' }
const emptyText: Record<string, string> = {
  all: 'No decisions, mentions or tasks are waiting on you.',
  approvals: 'Agent actions that need your decision will appear here.',
  mentions: 'Unread messages that mention you will appear here.',
  agents: 'Runs you start appear here while they work and for three days after.',
  tasks: 'Tasks assigned to you, and your Tasks waiting for review, appear here.',
  mail: 'No unread mail in your mailboxes.',
  chats: 'No unread conversations.',
}
</script>

<template>
  <div class="flex h-full min-h-0 min-w-0 flex-col">
    <LayoutPageHeader title="Inbox" icon="i-ph-tray">
      <template #actions><UButton icon="i-ph-arrow-clockwise" color="neutral" variant="ghost" aria-label="Refresh inbox" :loading="pending" @click="refresh" /></template>
    </LayoutPageHeader>
    <main class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto max-w-3xl px-4 py-6 sm:px-8 sm:py-10">
        <h2 class="text-xl font-semibold text-highlighted">{{ titles[section] }}</h2>
        <LayoutLoadError v-if="error" inline class="mt-6" message="Part of your inbox did not load. What loaded is shown below." :retry="retryFailed" />
        <LayoutSkeleton v-if="pending && !inbox && !unreadConversations.length" variant="nav" class="mt-6" :rows="5" />
        <LayoutEmptyState v-else-if="empty && !error && !pending" icon="i-ph-check-circle" title="You're all caught up" :description="emptyText[section]" class="mt-6" />
        <div v-else class="mt-8 space-y-10">
          <section v-if="shows('approvals') && counts.approvals" aria-labelledby="inbox-approvals">
            <h3 id="inbox-approvals" class="mb-2 text-xs font-medium text-muted">Waiting for your decision</h3>
            <ul class="divide-y divide-default">
              <li v-for="approval in inbox!.approvals" :key="approval.id" class="flex min-h-16 items-center gap-3 px-2 py-3">
                <UIcon name="i-ph-shield-check" class="size-5 shrink-0 text-primary" />
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm font-medium text-highlighted">{{ approvalText(approval) }}</p>
                  <p class="mt-0.5 truncate text-xs text-muted">{{ approval.taskTitle || 'Conversation run' }} · {{ formatMessageTime(approval.createdAt) }}</p>
                </div>
                <UButton :to="`/runs/${approval.runId}`" label="Review" size="sm" />
              </li>
            </ul>
          </section>

          <section v-if="shows('mentions') && counts.mentions" aria-labelledby="inbox-mentions">
            <h3 id="inbox-mentions" class="mb-2 text-xs font-medium text-muted">Mentions</h3>
            <ul class="divide-y divide-default">
              <li v-for="mention in inbox!.mentions" :key="mention.messageId">
                <NuxtLink :to="mention.path" class="flex items-start gap-3 rounded-md px-2 py-3 hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary">
                  <UserAvatar :user="mention.author" size="sm" />
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-sm"><span class="font-medium text-highlighted">{{ mention.author.displayName }}</span><span class="text-muted"> in {{ mention.conversation }} · {{ formatMessageTime(mention.createdAt) }}</span></p>
                    <p class="mt-0.5 line-clamp-2 text-sm text-default">{{ mention.excerpt }}</p>
                  </div>
                </NuxtLink>
              </li>
            </ul>
          </section>

          <section v-if="shows('agents') && counts.agents" aria-labelledby="inbox-agents">
            <h3 id="inbox-agents" class="mb-2 text-xs font-medium text-muted">Agent work you started</h3>
            <ul class="divide-y divide-default">
              <li v-for="run in [...activeRuns, ...finishedRuns]" :key="run.id">
                <NuxtLink :to="`/runs/${run.id}`" class="flex min-h-14 items-center gap-3 rounded-md px-2 py-3 hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary">
                  <UIcon :name="runState[run.status].icon" class="size-5 shrink-0" :class="[runState[run.status].color, run.status === 'running' && 'animate-spin']" />
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-sm font-medium text-highlighted">{{ run.taskTitle || run.conversation }}</p>
                    <p class="mt-0.5 truncate text-xs text-muted">{{ run.agentName }} · {{ runState[run.status].label }} · {{ formatMessageTime(run.updatedAt) }}</p>
                  </div>
                  <UBadge v-if="run.pullNumber" color="neutral" variant="subtle" icon="i-ph-git-branch" :label="`Draft PR #${run.pullNumber}`" />
                  <UIcon name="i-ph-caret-right" class="size-4 shrink-0 text-muted" />
                </NuxtLink>
              </li>
            </ul>
          </section>

          <section v-if="shows('tasks') && counts.tasks" aria-labelledby="inbox-tasks" class="space-y-6">
            <h3 id="inbox-tasks" class="sr-only">My tasks</h3>
            <div v-for="group in [{ label: 'Waiting for your review', tasks: inbox!.review }, { label: 'Assigned to you', tasks: inbox!.assigned }].filter(group => group.tasks.length)" :key="group.label">
              <h4 class="mb-2 text-xs font-medium text-muted">{{ group.label }}</h4>
              <ul class="divide-y divide-default">
                <li v-for="task in group.tasks" :key="task.id">
                  <NuxtLink :to="{ path: '/tasks', query: { task: task.id } }" class="flex min-h-14 items-center gap-3 rounded-md px-2 py-3 hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary">
                    <span class="w-10 shrink-0 text-xs tabular-nums text-muted">#{{ task.number }}</span>
                    <div class="min-w-0 flex-1">
                      <p class="truncate text-sm font-medium text-highlighted">{{ task.title }}</p>
                      <p class="mt-0.5 truncate text-xs text-muted">{{ taskMeta(task) }}</p>
                    </div>
                    <UIcon name="i-ph-caret-right" class="size-4 shrink-0 text-muted" />
                  </NuxtLink>
                </li>
              </ul>
            </div>
          </section>

          <section v-if="shows('mail') && counts.mail" aria-labelledby="inbox-mail">
            <h3 id="inbox-mail" class="mb-2 text-xs font-medium text-muted">Unread mail</h3>
            <ul class="divide-y divide-default">
              <li v-for="mailbox in unreadMailboxes" :key="mailbox.channelId">
                <NuxtLink :to="mailPath(mailbox.channelId)" class="flex min-h-14 items-center gap-3 rounded-md px-2 py-3 hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary">
                  <UIcon name="i-ph-envelope-simple" class="size-5 shrink-0 text-muted" />
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-sm font-medium text-highlighted">{{ mailbox.displayName || mailbox.address }}</p>
                    <p class="mt-0.5 truncate text-xs text-muted">{{ mailbox.address }}</p>
                  </div>
                  <UBadge color="neutral" variant="subtle" :label="`${mailbox.unreadCount > 99 ? '99+' : mailbox.unreadCount} unread`" />
                </NuxtLink>
              </li>
            </ul>
          </section>

          <section v-if="shows('chats') && counts.chats" aria-labelledby="inbox-chats">
            <h3 id="inbox-chats" class="mb-2 text-xs font-medium text-muted">Unread chats</h3>
            <ul class="divide-y divide-default">
              <li v-for="channel in unreadConversations" :key="channel.id">
                <NuxtLink :to="channelPath(channel)" :title="conversationTitle(channel, session.user?.id || '')" class="flex min-h-12 items-center gap-3 rounded-md px-2 py-2.5 hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary" @pointerenter="warm.intent(channel.id)" @pointerleave="warm.cancel()" @focus="warm.prefetch(channel.id)">
                  <UIcon :name="chatIcon(channel)" class="size-5 shrink-0 text-muted" />
                  <p class="min-w-0 flex-1 truncate text-sm text-highlighted">{{ conversationTitle(channel, session.user?.id || '') }}</p>
                  <UBadge color="neutral" variant="subtle" :label="channel.unreadCount ? `${channel.unreadCount > 99 ? '99+' : channel.unreadCount} unread` : 'Unread'" />
                </NuxtLink>
              </li>
            </ul>
          </section>
        </div>
      </div>
    </main>
  </div>
</template>
