<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { AgentDTO } from '~~/shared/types'
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
  <SettingsHeader title="Agents" description="Manage the teammates people can message and work with.">
    <template #actions><UButton v-if="tab === 'agents'" icon="i-ph-plus" label="Create agent" @click="edit()" /></template>
  </SettingsHeader>
  <UTabs v-model="tab" :items="[{ label: 'Agents', value: 'agents', icon: 'i-ph-robot' }, ...(isOwner ? [{ label: 'Providers', value: 'providers', icon: 'i-ph-plugs-connected' }] : [])]" :content="false" class="mt-6 mb-5" />
  <SettingsAgentProviderSettings v-if="tab === 'providers'" :server-id="serverId" :is-owner="isOwner" />
  <template v-else>
  <UInput v-model="query" icon="i-ph-magnifying-glass" placeholder="Search agents" aria-label="Search agents" class="w-full" />
  <LayoutSkeleton v-if="agentsQ.isPending.value" variant="nav" class="mt-6" :rows="3" />
  <LayoutLoadError v-else-if="agentsQ.error.value" message="Agents did not load." :retry="agentsQ.refetch" />
  <LayoutEmptyState v-else-if="!agentsQ.data.value?.agents.length" icon="i-ph-robot" title="No agents yet" description="Create an agent, then assign its Role and permissions." />
  <ul v-else class="mt-6 divide-y divide-default">
    <li v-for="agent in visible" :key="agent.id">
      <button type="button" class="flex min-h-16 w-full items-center gap-3 rounded-lg px-3 py-3 text-start hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary" :aria-label="`Edit ${agent.displayName}`" @click="edit(agent)">
        <UserAvatar :user="{ ...agent, kind: 'agent' }" size="md" />
        <span class="min-w-0 flex-1"><span class="block truncate text-sm font-medium text-highlighted">{{ agent.displayName }}</span><span class="block text-xs text-muted">{{ agent.status === 'paused' ? 'Paused' : 'Active' }} · {{ agent.harness === 'pi' ? 'Pi' : 'Think' }}</span></span>
        <UIcon name="i-ph-pencil-simple" class="size-4 text-muted" />
      </button>
    </li>
  </ul>
  <UPagination v-if="(agentsQ.data.value?.total ?? 0) > 15" v-model:page="page" :items-per-page="15" :total="agentsQ.data.value?.total ?? 0" />
  </template>
  <SettingsAgentEditorModal v-model:open="editorOpen" :server-id="serverId" :agent="editing" @saved="editing = $event" />
</template>
