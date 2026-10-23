<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { ChannelDTO } from '~~/shared/types'
const props = defineProps<{ serverId: string }>()
const route = useRoute()
const { api } = useApi()
const { agents, members, messageAgent } = useAgentDirectory(() => props.serverId)
const conversations = useQuery({ queryKey: ['dms'], queryFn: () => api<{ channels: ChannelDTO[] }>('/api/dms'), refetchInterval: 3000 })
const selectedAgent = computed(() => {
  const conversation = conversations.data.value?.channels.find(channel => channel.serverId === props.serverId && channel.id === route.params.channel)
  return conversation?.participants?.length === 2 ? conversation.participants.find(user => user.kind === 'agent')?.id : undefined
})
function conversationFor(id: string) { return conversations.data.value?.channels.find(c => c.participants?.some(p => p.id === id)) }
</script>

<template>
  <nav aria-label="Agent directory" class="space-y-2 px-2">
    <LayoutSkeleton v-if="members.isPending.value" variant="nav" :rows="3" />
    <LayoutLoadError v-else-if="members.error.value" inline message="Agents did not load." :retry="members.refetch" />
    <p v-else-if="!agents.length" class="px-2 py-2 text-sm text-muted">No agents yet.</p>
    <button
v-for="agent in agents"
      :key="agent.user.id"
      type="button"
      class="flex min-h-16 w-full items-center gap-2 rounded-md px-2 py-2 text-start hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary"
      :class="selectedAgent === agent.user.id ? 'bg-accented text-highlighted' : 'text-muted'"
      :aria-label="`Open the conversation with ${agent.user.displayName}`"
      :title="agent.user.displayName"
      @click="messageAgent(agent.user.id)"
    >
      <UserAvatar :user="agent.user" size="sm" />
      <span class="min-w-0 flex-1"><span class="block truncate text-sm font-medium">{{ agent.user.displayName }}</span><span class="block truncate text-xs" :class="conversationFor(agent.user.id)?.agentWorking ? 'text-primary' : 'text-muted'">{{ conversationFor(agent.user.id)?.agentWorking ? 'Working…' : conversationFor(agent.user.id)?.lastAgentMessage || 'Start a conversation' }}</span></span>
      <UIcon v-if="conversationFor(agent.user.id)?.agentWorking" name="i-ph-circle-notch" class="size-3 shrink-0 animate-spin text-primary" />
    </button>
  </nav>
</template>
