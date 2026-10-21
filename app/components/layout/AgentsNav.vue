<script setup lang="ts">
import { Permission } from '~~/shared/permissions'
const props = defineProps<{ serverId: string }>()
const route = useRoute()
const nav = useNavActions()
const { can } = useRoleGrants()
const { agents, members } = useAgentDirectory(() => props.serverId)
</script>

<template>
  <nav aria-label="Agent directory" class="space-y-3">
    <div class="px-2"><LayoutNavRow to="/agents" :active="!route.query.agent"><template #leading><UIcon name="i-ph-robot" class="size-[18px] text-muted" /></template>All agents</LayoutNavRow></div>
    <LayoutNavSection label="Agents" collapse-key="agents:directory" :create-label="can(Permission.manageAgents) ? 'Create agent' : undefined" @create="nav.createAgentOpen.value = true">
      <LayoutSkeleton v-if="members.isPending.value" variant="nav" :rows="3" />
      <LayoutLoadError v-else-if="members.error.value" inline message="Agents did not load." :retry="members.refetch" />
      <p v-else-if="!agents.length" class="px-2 py-2 text-sm text-muted">No agents yet.</p>
      <LayoutNavRow v-for="agent in agents" :key="agent.user.id" :to="`/agents?agent=${agent.user.id}`" :active="route.query.agent === agent.user.id" :title="agent.user.displayName">
        <template #leading><UserAvatar :user="agent.user" size="xs" /></template>{{ agent.user.displayName }}
      </LayoutNavRow>
    </LayoutNavSection>
  </nav>
</template>
