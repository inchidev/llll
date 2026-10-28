<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { AgentDTO } from '~~/shared/types'
const emit = defineEmits<{ navigate: [] }>()
const props = defineProps<{ serverId: string; isOwner?: boolean }>()
const { api } = useApi()
const editing = shallowRef<AgentDTO | null>(null)
const editorOpen = ref(false)
const tab = ref('agents')
const query = ref('')
const page = ref(1)
const agentsQ = useQuery({ queryKey: computed(() => ['agents', props.serverId, 'settings', query.value, page.value]), queryFn: () => api<{ agents: AgentDTO[]; total: number }>(`/api/servers/${props.serverId}/agents`, { query: { search: query.value, page: page.value } }) })
const visible = computed(() => agentsQ.data.value?.agents ?? [])
watch(query, () => { page.value = 1 })
function edit(agent: AgentDTO | null = null) { editing.value = agent; editorOpen.value = true }
</script>

<template>
  <SettingsHeader title="Agents">
    <template #actions><UButton :class="{ invisible: tab !== 'agents' }" :tabindex="tab === 'agents' ? undefined : -1" icon="i-ph-plus" label="Create agent" @click="edit()" /></template>
  </SettingsHeader>
  <UTabs v-model="tab" :items="[{ label: 'Agents', value: 'agents', icon: 'i-ph-robot' }, ...(isOwner ? [{ label: 'Providers', value: 'providers', icon: 'i-ph-plugs-connected' }, { label: 'Execution', value: 'execution', icon: 'i-ph-play-circle' }, { label: 'Audit', value: 'audit', icon: 'i-ph-list-magnifying-glass' }] : [])]" :content="false" class="mt-6 mb-5" />
  <SettingsAgentExecutionSettings v-if="tab === 'execution' && isOwner" :server-id="serverId" />
  <SettingsAgentProviderSettings v-else-if="tab === 'providers'" :server-id="serverId" :is-owner="isOwner" />
  <SettingsAgentAudit v-else-if="tab === 'audit'" :server-id="serverId" @navigate="emit('navigate')" />
  <template v-else>
  <UInput v-model="query" icon="i-ph-magnifying-glass" placeholder="Search agents" aria-label="Search agents" class="w-full" />
  <LayoutSkeleton v-if="agentsQ.isPending.value" variant="nav" class="mt-6" :rows="3" />
  <LayoutLoadError v-else-if="agentsQ.error.value" message="Agents did not load." :retry="agentsQ.refetch" />
  <LayoutEmptyState v-else-if="!agentsQ.data.value?.agents.length" icon="i-ph-robot" title="No agents yet" description="Create an agent, then assign its Role and permissions." />
  <SettingsList v-else class="mt-6" :items="visible" :item-key="agent => agent.id" :search-text="agent => agent.displayName" :search-from="Infinity" :noun="['agent', 'agents']" @select="edit">
      <template #row="{ item: agent }">
        <UserAvatar :user="{ ...agent, kind: 'agent' }" size="md" />
        <span class="min-w-0 flex-1"><span class="block truncate text-sm font-medium text-highlighted">{{ agent.displayName }}</span><span class="block text-xs text-muted">{{ agent.status === 'paused' ? 'Paused' : 'Active' }}</span></span>
      </template>
  </SettingsList>
  <UPagination v-if="(agentsQ.data.value?.total ?? 0) > 15" v-model:page="page" :items-per-page="15" :total="agentsQ.data.value?.total ?? 0" />
  </template>
  <SettingsAgentEditorModal v-model:open="editorOpen" :server-id="serverId" :agent="editing" @saved="editing = $event" />
</template>
