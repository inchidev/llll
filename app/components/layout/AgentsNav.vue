<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { Permission } from '~~/shared/permissions'
import type { ChannelDTO, SidebarThreadDTO } from '~~/shared/types'
const props = defineProps<{ serverId: string }>()
const route = useRoute()
const { api } = useApi()
const nav = useNavActions()
const { can } = useRoleGrants()
const { agents, members, messageAgent } = useAgentDirectory(() => props.serverId)
// A Schedule is the one thing here that needs neither: its own permission brings someone to this section.
const showsAgents = computed(() => can(Permission.useAgents) || can(Permission.manageAgents))
const conversations = useQuery({ queryKey: ['dms'], queryFn: () => api<{ channels: ChannelDTO[]; threads?: SidebarThreadDTO[] }>('/api/dms'), refetchInterval: 3000, enabled: showsAgents })
const selectedAgent = computed(() => {
  const conversation = conversations.data.value?.channels.find(channel => channel.serverId === props.serverId && channel.id === route.params.channel)
  return conversation?.participants?.length === 2 ? conversation.participants.find(user => user.kind === 'agent')?.id : undefined
})
// With a thread open, only the thread row is highlighted; its agent just stays readable.
const threadOpen = computed(() => Boolean(route.params.threadId))
function conversationFor(id: string) { return conversations.data.value?.channels.find(c => c.serverId === props.serverId && c.participants?.some(p => p.id === id)) }
function statusOf(agent: { agentStatus?: string | null; user: { id: string; displayName: string } }) {
  const conversation = conversationFor(agent.user.id)
  return agent.agentStatus === 'paused' ? 'Paused' : conversation?.agentWorking ? 'Working…' : conversation?.lastAgentMessage || 'Start a conversation'
}
</script>

<template>
  <nav aria-label="Agents" class="space-y-3">
    <div v-if="can(Permission.manageSchedules)" class="px-2">
      <LayoutNavRow to="/schedules" :active="route.path.startsWith('/schedules')">
        <template #leading><UIcon name="i-ph-clock" class="size-[18px] shrink-0 text-dimmed" /></template>
        Schedules
      </LayoutNavRow>
    </div>
    <LayoutNavSection
      v-if="showsAgents"
      label="Agents"
      collapse-key="agents:list"
      :create-label="can(Permission.manageAgents) ? 'Create agent' : undefined"
      @create="nav.createAgentOpen.value = true"
    >
      <LayoutSkeleton v-if="members.isPending.value" variant="nav" :rows="3" />
      <LayoutLoadError v-else-if="members.error.value" inline message="Agents did not load." :retry="members.refetch" />
      <p v-else-if="!agents.length" class="px-2 py-2 text-sm text-muted">No agents yet.</p>
      <ul v-else>
        <li v-for="agent in agents" :key="agent.user.id">
          <LayoutNavRow
            :active="selectedAgent === agent.user.id && !threadOpen"
            :ancestor="selectedAgent === agent.user.id && threadOpen"
            :class="{ 'cursor-not-allowed opacity-60': agent.agentStatus === 'paused' }"
            :aria-label="`Open the conversation with ${agent.user.displayName}`"
            :title="`${agent.user.displayName}: ${statusOf(agent)}`"
            :disabled="agent.agentStatus === 'paused'"
            @click="messageAgent(agent.user.id)"
          >
            <template #leading><UserAvatar :user="agent.user" size="2xs" /></template>
            {{ agent.user.displayName }}
            <template #trailing>
              <UIcon v-if="conversationFor(agent.user.id)?.agentWorking" name="i-ph-circle-notch" class="size-3 shrink-0 animate-spin text-primary" aria-label="Working" />
              <span v-else-if="agent.agentStatus === 'paused'" class="shrink-0 text-[11px] text-dimmed">Paused</span>
            </template>
          </LayoutNavRow>
          <LayoutNavThreads
            v-if="conversationFor(agent.user.id)"
            class="mt-1"
            :channel="conversationFor(agent.user.id)!"
            :threads="conversations.data.value?.threads?.filter(thread => thread.parentId === conversationFor(agent.user.id)?.id) ?? []"
            :label="agent.user.displayName"
          />
        </li>
      </ul>
    </LayoutNavSection>
  </nav>
</template>
