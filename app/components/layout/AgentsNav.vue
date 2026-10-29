<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { ChannelDTO, SidebarThreadDTO } from '~~/shared/types'
const props = defineProps<{ serverId: string }>()
const route = useRoute()
const { api } = useApi()
const { agents, members, messageAgent } = useAgentDirectory(() => props.serverId)
const conversations = useQuery({ queryKey: ['dms'], queryFn: () => api<{ channels: ChannelDTO[]; threads?: SidebarThreadDTO[] }>('/api/dms'), refetchInterval: 3000 })
const selectedAgent = computed(() => {
  const conversation = conversations.data.value?.channels.find(channel => channel.serverId === props.serverId && channel.id === route.params.channel)
  return conversation?.participants?.length === 2 ? conversation.participants.find(user => user.kind === 'agent')?.id : undefined
})
// With a thread open, only the thread row is highlighted; its agent just stays readable.
const threadOpen = computed(() => Boolean(route.params.threadId))
function conversationFor(id: string) { return conversations.data.value?.channels.find(c => c.serverId === props.serverId && c.participants?.some(p => p.id === id)) }
</script>

<template>
  <nav aria-label="Agent directory" class="space-y-2 px-2">
    <LayoutSkeleton v-if="members.isPending.value" variant="nav" :rows="3" />
    <LayoutLoadError v-else-if="members.error.value" inline message="Agents did not load." :retry="members.refetch" />
    <p v-else-if="!agents.length" class="px-2 py-2 text-sm text-muted">No agents yet.</p>
    <ul v-else class="space-y-1">
      <li v-for="agent in agents" :key="agent.user.id">
        <button
          type="button"
          class="flex min-h-16 w-full items-center gap-2 rounded-md px-2 py-2 text-start hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary"
          :class="[selectedAgent === agent.user.id ? (threadOpen ? 'text-highlighted' : 'bg-accented text-highlighted') : 'text-muted', { 'cursor-not-allowed opacity-60': agent.agentStatus === 'paused' }]"
          :aria-label="`Open the conversation with ${agent.user.displayName}`"
          :title="agent.user.displayName"
          :disabled="agent.agentStatus === 'paused'"
          @click="messageAgent(agent.user.id)"
        >
          <UserAvatar :user="agent.user" size="sm" />
          <span class="min-w-0 flex-1"><span class="block truncate text-sm font-medium">{{ agent.user.displayName }}</span><span class="block truncate text-xs" :class="conversationFor(agent.user.id)?.agentWorking ? 'text-primary' : 'text-muted'">{{ agent.agentStatus === 'paused' ? 'Paused' : conversationFor(agent.user.id)?.agentWorking ? 'Working…' : conversationFor(agent.user.id)?.lastAgentMessage || 'Start a conversation' }}</span></span>
          <UIcon v-if="conversationFor(agent.user.id)?.agentWorking" name="i-ph-circle-notch" class="size-3 shrink-0 animate-spin text-primary" />
        </button>
        <LayoutNavThreads
          v-if="conversationFor(agent.user.id)"
          class="mt-1"
          :channel="conversationFor(agent.user.id)!"
          :threads="conversations.data.value?.threads?.filter(thread => thread.parentId === conversationFor(agent.user.id)?.id) ?? []"
          :label="agent.user.displayName"
        />
      </li>
    </ul>
  </nav>
</template>
