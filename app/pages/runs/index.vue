<script setup lang="ts">
import { useInfiniteQuery } from '@tanstack/vue-query'
import type { RunListPage } from '~~/server/utils/agent-run-list'
import { runStatusColor } from '~~/shared/agent-run-status'

definePageMeta({ layout: 'server', middleware: ['auth'] })
const route = useRoute()
const { api } = useApi()
const allValue = '__all__'
const statuses = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const
/** Filters live in the URL so a filtered list can be linked and survives reloads. */
const status = computed({
  get: () => statuses.find(item => item === route.query.status) ?? allValue,
  set: (value: string) => void navigateTo({ query: { ...route.query, status: value === allValue ? undefined : value } }, { replace: true }),
})
const agentId = computed({
  get: () => String(route.query.agent || '') || allValue,
  set: (value: string) => void navigateTo({ query: { ...route.query, agent: value === allValue ? undefined : value } }, { replace: true }),
})
const runsQ = useInfiniteQuery({
  queryKey: computed(() => ['agent-runs', status.value, agentId.value]),
  queryFn: ({ pageParam }) => api<RunListPage>('/api/agent-runs', { query: {
    status: status.value === allValue ? undefined : status.value,
    agentId: agentId.value === allValue ? undefined : agentId.value,
    cursor: pageParam || undefined,
  } }),
  initialPageParam: '',
  getNextPageParam: last => last.nextCursor ?? undefined,
  refetchInterval: query => query.state.data?.pages.some(page => page.runs.some(run => run.status === 'queued' || run.status === 'running')) ? 5000 : false,
})
const runs = computed(() => runsQ.data.value?.pages.flatMap(page => page.runs) ?? [])
const statusItems = [{ value: allValue, label: 'All statuses' }, ...statuses.map(value => ({ value, label: value.charAt(0).toUpperCase() + value.slice(1) }))]
const agentItems = computed(() => [{ value: allValue, label: 'All agents' }, ...(runsQ.data.value?.pages[0]?.agents ?? []).map(agent => ({ value: agent.id, label: agent.displayName }))])
const filtered = computed(() => status.value !== allValue || agentId.value !== allValue)
</script>

<template>
  <div class="flex h-full min-h-0 min-w-0 flex-col">
    <LayoutPageHeader title="Runs" icon="i-ph-list-bullets" />
    <main class="mx-auto w-full max-w-3xl flex-1 space-y-4 overflow-auto p-4 sm:p-8">
      <p class="text-sm text-muted">Runs you started, newest first. Run content stays private to the person who started it.</p>
      <div class="flex flex-wrap gap-2">
        <USelect v-model="status" :items="statusItems" aria-label="Filter by status" class="w-44" />
        <USelect v-model="agentId" :items="agentItems" aria-label="Filter by agent" class="w-52" />
      </div>
      <LayoutSkeleton v-if="runsQ.isPending.value" variant="rows" :rows="5" />
      <LayoutLoadError v-else-if="runsQ.error.value" message="Runs did not load." :retry="runsQ.refetch" />
      <LayoutEmptyState v-else-if="!runs.length" icon="i-ph-robot" :title="filtered ? 'No matching runs' : 'No runs yet'" :description="filtered ? 'Change the filters to see other runs.' : 'Runs appear here when you message an agent or start an assigned task.'" />
      <ul v-else class="divide-y divide-default rounded-lg border border-default">
        <li v-for="run in runs" :key="run.id">
          <NuxtLink :to="`/runs/${run.id}`" class="block px-4 py-3 hover:bg-elevated/60">
            <div class="flex items-center gap-2">
              <span class="min-w-0 flex-1 truncate text-sm font-medium text-highlighted">{{ run.agentName }}<span v-if="run.taskNumber" class="font-normal text-muted"> · Task #{{ run.taskNumber }}</span></span>
              <UBadge :label="run.status" :color="runStatusColor(run.status)" variant="subtle" size="sm" />
            </div>
            <p class="mt-1 line-clamp-2 text-sm text-muted">{{ run.prompt }}</p>
            <p class="mt-1 text-xs text-muted">{{ new Date(run.createdAt).toLocaleString() }} · {{ run.modelCalls }} model calls · {{ run.totalTokens }} tokens</p>
          </NuxtLink>
        </li>
      </ul>
      <UButton v-if="runsQ.hasNextPage.value" label="Load older runs" color="neutral" variant="soft" block :loading="runsQ.isFetchingNextPage.value" @click="runsQ.fetchNextPage()" />
    </main>
  </div>
</template>
