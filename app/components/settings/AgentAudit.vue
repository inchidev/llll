<script setup lang="ts">
import { keepPreviousData, useQuery } from '@tanstack/vue-query'
import type { AgentAuditPage } from '~~/shared/agent-audit'
import { parseAgentModelRef } from '~~/shared/agent-providers'
import { formatDateTime } from '~~/shared/format'
const emit = defineEmits<{ navigate: [] }>()
const props = defineProps<{ serverId: string }>()
const { api } = useApi()
const view = ref<'runs' | 'changes'>('runs'), search = ref(''), page = ref(1)
const audit = useQuery({ queryKey: computed(() => ['agent-audit', props.serverId, view.value, search.value, page.value]), queryFn: ({ signal }) => api<AgentAuditPage>(`/api/servers/${props.serverId}/agent-audit`, { query: { view: view.value, search: search.value, page: page.value }, signal }), placeholderData: keepPreviousData, refetchInterval: 5000 })
watch([search, view], () => { page.value = 1 })
</script>
<template>
  <section class="space-y-4" aria-label="Agent audit">
    <UTabs v-model="view" :items="[{ label: 'Runs', value: 'runs' }, { label: 'Changes', value: 'changes' }]" :content="false" variant="link" />
    <UInput v-model="search" icon="i-ph-magnifying-glass" placeholder="Search audit" aria-label="Search agent audit" class="w-full" />
    <LayoutSkeleton v-if="audit.isPending.value" variant="rows" :rows="4" />
    <LayoutLoadError v-else-if="audit.error.value" message="Agent audit did not load." :retry="audit.refetch" />
    <LayoutEmptyState v-else-if="!audit.data.value?.entries.length" icon="i-ph-list-magnifying-glass" title="No matching activity" description="Runs and changes will appear here as agents are used." />
    <ul v-else class="divide-y divide-default" :aria-busy="audit.isFetching.value">
      <li v-for="entry in audit.data.value.entries" :key="entry.id" class="min-w-0 space-y-1 py-4">
        <template v-if="entry.kind === 'run'">
          <div class="flex flex-wrap items-center justify-between gap-2"><NuxtLink :to="`/runs/${entry.id}`" class="text-sm font-medium text-highlighted underline" @click="emit('navigate')">{{ entry.agentName }}</NuxtLink><UBadge :label="entry.status" :color="entry.status === 'failed' ? 'error' : entry.status === 'running' ? 'primary' : 'neutral'" size="xs" variant="subtle" /></div>
          <p v-if="entry.lastError" class="text-sm text-error">{{ entry.lastError }}</p>
          <p class="truncate text-sm text-muted" :title="entry.model">{{ parseAgentModelRef(entry.model)?.model ?? entry.model }}</p>
          <p class="text-xs text-muted">{{ entry.modelCalls }} model calls · {{ entry.toolCalls }} tool calls · {{ entry.totalTokens.toLocaleString() }} tokens</p>
          <p class="text-xs text-muted">{{ entry.initiatorName }} · {{ formatDateTime(entry.createdAt) }}</p>
        </template>
        <template v-else>
          <p class="break-words text-sm font-medium text-highlighted">{{ entry.action }}</p>
          <p class="text-xs text-muted">{{ entry.actorName }} · {{ formatDateTime(entry.createdAt) }}</p>
          <p class="truncate text-xs text-muted" :title="entry.targetId">{{ entry.targetType }} · {{ entry.targetId }}</p>
        </template>
      </li>
    </ul>
    <UPagination v-if="(audit.data.value?.total ?? 0) > 20" v-model:page="page" :items-per-page="20" :total="audit.data.value?.total ?? 0" />
  </section>
</template>
