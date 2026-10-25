<script setup lang="ts">
import { keepPreviousData, useQuery } from '@tanstack/vue-query'
import { agentModelLabel, type AgentProviderCatalog } from '~~/shared/agent-providers'
import type { ClientMsg } from '~~/shared/types'
const props = defineProps<{ channelId: string; agentId: string; send: (message: ClientMsg) => void; disabled?: boolean }>()
const emit = defineEmits<{ busy: [value: boolean]; saving: [value: boolean] }>()
const { api } = useApi(), session = useSessionStore(), toast = useToast()
const saving = ref(false), search = ref(''), controlling = ref(false)
type Run = { id: string; channelId: string; initiatedBy: string; prompt: string; agentId: string; status: string }
type State = AgentProviderCatalog & { selected: string | null; active: Run[] }
const state = useQuery({ queryKey: computed(() => ['agent-model', props.channelId, search.value]), queryFn: ({ signal }) => api<State>(`/api/channels/${props.channelId}/agent-model`, { signal, timeout: 10000, query: { search: search.value } }), refetchInterval: 2000, placeholderData: keepPreviousData })
const runs = useQuery({ queryKey: computed(() => ['agent-conversation-runs', props.channelId]), queryFn: ({ signal }) => api<{ active: Run[] }>(`/api/channels/${props.channelId}/agent-runs`, { signal, timeout: 10000 }), refetchInterval: 1000, staleTime: 0 })
const active = computed(() => runs.data.value?.active.filter(run => run.agentId === props.agentId) ?? [])
const working = computed(() => active.value.some(run => run.status === 'running'))
const queued = computed(() => active.value.filter(run => run.status === 'queued'))
watch(() => active.value.length > 0, value => emit('busy', value), { immediate: true })
const models = computed(() => (state.data.value?.models ?? []).map(model => ({ value: model.value, label: agentModelLabel(model) })))
async function select(model: string) {
  if (saving.value) return
  saving.value = true; emit('saving', true)
  try { await api(`/api/channels/${props.channelId}/agent-model`, { method: 'PUT', body: { model } }); await state.refetch() }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { saving.value = false; emit('saving', false) }
}
async function stop() {
  if (controlling.value) return
  controlling.value = true
  try {
    const latest = await runs.refetch({ throwOnError: true })
    const current = latest.data?.active.filter(run => run.agentId === props.agentId) ?? []
    for (const run of [...current.filter(run => run.status === 'queued'), ...current.filter(run => run.status === 'running')]) {
      await api(`/api/agent-runs/${run.id}/cancel`, { method: 'POST' })
    }
  }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { await runs.refetch(); controlling.value = false }
}
async function steer(run: Run) {
  if (controlling.value) return
  controlling.value = true
  try {
    const latest = await runs.refetch({ throwOnError: true })
    const current = latest.data?.active.filter(item => item.agentId === props.agentId) ?? []
    if (!current.some(item => item.id === run.id && item.status === 'queued') || !current.some(item => item.status === 'running')) {
      toast.add({ title: 'This queued message is no longer available to steer. The queue has been refreshed.', color: 'error' })
      return
    }
    await api(`/api/agent-runs/${run.id}/steer`, { method: 'POST' })
  }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { await runs.refetch(); controlling.value = false }
}
</script>
<template>
  <div class="@container border-b border-default" role="group" aria-label="Agent controls">
    <ul v-if="queued.length" class="max-h-36 space-y-1 overflow-auto border-b border-default p-2" aria-label="Queued messages">
      <li v-for="run in queued" :key="run.id" class="flex min-w-0 items-center gap-2 text-xs"><UIcon name="i-ph-clock" class="size-3 shrink-0 text-muted" /><span class="min-w-0 flex-1 truncate">{{ run.prompt }}</span><UBadge label="Queued" size="xs" color="neutral" variant="subtle" /><UButton v-if="working && run.initiatedBy === session.user?.id" :disabled="disabled || controlling" label="Steer" size="xs" variant="ghost" color="neutral" @click="steer(run)" /></li>
    </ul>
    <LayoutLoadError v-if="runs.error.value" inline message="Agent queue did not refresh." :retry="runs.refetch" />
    <div class="flex min-w-0 items-center gap-1 px-2 py-1.5">
      <UIcon name="i-ph-robot" class="mx-1 size-4 shrink-0 text-muted" />
      <USelectMenu v-if="models.length || search" v-model:search-term="search" :loading="state.isFetching.value" ignore-filter :model-value="state.data.value?.selected ?? undefined" :items="models" value-key="value" virtualize :disabled="disabled || saving" size="xs" variant="ghost" class="min-w-0 flex-1" :ui="{ base: 'min-w-0', value: 'truncate' }" placeholder="Choose provider / model" aria-label="Provider / model" @update:model-value="select" />
      <span v-else class="min-w-0 flex-1 truncate text-xs text-muted">{{ state.isPending.value ? 'Loading models…' : state.error.value ? 'Models unavailable' : 'Connect a provider in Server settings' }}</span>
      <UTooltip v-if="working" text="Stop agent"><UButton icon="i-ph-stop-fill" aria-label="Stop agent" :disabled="disabled || controlling" size="xs" variant="ghost" color="error" @click="stop"><span class="hidden @sm:inline">Stop</span></UButton></UTooltip>
      <UButton v-if="state.error.value" icon="i-ph-arrow-clockwise" aria-label="Retry model list" size="xs" variant="ghost" color="neutral" @click="state.refetch()" />
    </div>
  </div>
</template>
