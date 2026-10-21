<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { AgentDTO } from '~~/shared/types'
const props = defineProps<{ serverId: string }>()
const { api } = useApi()
const editing = shallowRef<AgentDTO | null>(null)
const editorOpen = ref(false)
const agentsQ = useQuery({ queryKey: computed(() => ['agents', props.serverId]), queryFn: () => api<{ agents: AgentDTO[] }>(`/api/servers/${props.serverId}/agents`) })
function edit(agent: AgentDTO | null = null) { editing.value = agent; editorOpen.value = true }
</script>

<template>
  <SettingsHeader title="Agents" description="Manage the teammates people can message and work with.">
    <template #actions><UButton icon="i-ph-plus" label="Create agent" @click="edit()" /></template>
  </SettingsHeader>
  <LayoutSkeleton v-if="agentsQ.isPending.value" variant="nav" class="mt-6" :rows="3" />
  <LayoutLoadError v-else-if="agentsQ.error.value" message="Agents did not load." :retry="agentsQ.refetch" />
  <LayoutEmptyState v-else-if="!agentsQ.data.value?.agents.length" icon="i-ph-robot" title="No agents yet" description="Create an agent, then assign its Role and permissions." />
  <ul v-else class="mt-6 divide-y divide-default">
    <li v-for="agent in agentsQ.data.value.agents" :key="agent.id">
      <button type="button" class="flex min-h-16 w-full items-center gap-3 rounded-lg px-3 py-3 text-start hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary" :aria-label="`Edit ${agent.displayName}`" @click="edit(agent)">
        <UserAvatar :user="{ ...agent, kind: 'agent' }" size="md" />
        <span class="min-w-0 flex-1"><span class="block truncate text-sm font-medium text-highlighted">{{ agent.displayName }}</span><span class="block text-xs text-muted">{{ agent.status === 'paused' ? 'Paused' : 'Active' }} · {{ agent.harness === 'pi' ? 'Pi' : 'Think' }}</span></span>
        <UIcon name="i-ph-pencil-simple" class="size-4 text-muted" />
      </button>
    </li>
  </ul>
  <SettingsAgentEditorModal v-model:open="editorOpen" :server-id="serverId" :agent="editing" @saved="editing = $event" />
</template>
