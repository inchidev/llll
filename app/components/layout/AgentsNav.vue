<script setup lang="ts">
import { Permission } from '~~/shared/permissions'
const props = defineProps<{ serverId: string }>()
const { can } = useRoleGrants()
const { agents, members, messageAgent, opening } = useAgentDirectory(() => props.serverId)
</script>

<template>
  <nav aria-label="Agent directory" class="space-y-2 px-2">
    <LayoutSkeleton v-if="members.isPending.value" variant="nav" :rows="3" />
    <LayoutLoadError v-else-if="members.error.value" inline message="Agents did not load." :retry="members.refetch" />
    <p v-else-if="!agents.length" class="px-2 py-2 text-sm text-muted">No agents yet.</p>
    <LayoutNavRow
      v-for="agent in agents"
      :key="agent.user.id"
      :unread="opening === agent.user.id"
      :aria-label="`Open the conversation with ${agent.user.displayName}`"
      :title="agent.user.displayName"
      @click="messageAgent(agent.user.id)"
    >
      <template #leading><UserAvatar :user="agent.user" size="xs" /></template>{{ agent.user.displayName }}
    </LayoutNavRow>
    <p v-if="can(Permission.manageAgents)" class="px-2 pt-1 text-[11px] text-muted">
      Manage agents from the directory page.
    </p>
  </nav>
</template>
