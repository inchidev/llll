<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { ChannelDTO } from '~~/shared/types'
const props = defineProps<{ serverId: string }>()
const route = useRoute()
const { api } = useApi()
const { agents, members, messageAgent, opening } = useAgentDirectory(() => props.serverId)
const conversations = useQuery({ queryKey: ['dms'], queryFn: () => api<{ channels: ChannelDTO[] }>('/api/dms') })
const selectedAgent = computed(() => {
  const conversation = conversations.data.value?.channels.find(channel => channel.serverId === props.serverId && channel.id === route.params.channel)
  return conversation?.participants?.length === 2 ? conversation.participants.find(user => user.kind === 'agent')?.id : undefined
})
</script>

<template>
  <nav aria-label="Agent directory" class="space-y-2 px-2">
    <LayoutSkeleton v-if="members.isPending.value" variant="nav" :rows="3" />
    <LayoutLoadError v-else-if="members.error.value" inline message="Agents did not load." :retry="members.refetch" />
    <p v-else-if="!agents.length" class="px-2 py-2 text-sm text-muted">No agents yet.</p>
    <LayoutNavRow
      v-for="agent in agents"
      :key="agent.user.id"
      :active="selectedAgent === agent.user.id"
      :unread="opening === agent.user.id"
      :aria-label="`Open the conversation with ${agent.user.displayName}`"
      :title="agent.user.displayName"
      @click="messageAgent(agent.user.id)"
    >
      <template #leading><UserAvatar :user="agent.user" size="xs" /></template>{{ agent.user.displayName }}
    </LayoutNavRow>
  </nav>
</template>
