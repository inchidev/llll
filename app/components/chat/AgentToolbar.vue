<script setup lang="ts">
import { displayAgentPrompt } from '~~/shared/agent-images'
import { useMediaQuery } from '@vueuse/core'
import { keepPreviousData, useQuery } from '@tanstack/vue-query'
import { agentModelLabel, type AgentEffort, type AgentModelOption, type AgentProviderCatalog } from '~~/shared/agent-providers'
import type { ClientMsg } from '~~/shared/types'
const props = defineProps<{ channelId: string; agentId: string; send: (message: ClientMsg) => void; disabled?: boolean }>()
const emit = defineEmits<{ busy: [value: boolean]; saving: [value: boolean] }>()
const { api } = useApi(), session = useSessionStore(), toast = useToast()
const saving = ref(false), search = ref(''), controlling = ref(false)
type Run = { id: string; channelId: string; initiatedBy: string; prompt: string; agentId: string; status: string }
type State = AgentProviderCatalog & { selected: string | null; effort?: AgentEffort; active: Run[] }
const state = useQuery({ queryKey: computed(() => ['agent-model', props.channelId, search.value]), queryFn: ({ signal }) => api<State>(`/api/channels/${props.channelId}/agent-model`, { signal, timeout: 10000, query: { search: search.value } }), retry: 1, refetchInterval: 30000, placeholderData: keepPreviousData })
const runs = useQuery({ queryKey: computed(() => ['agent-conversation-runs', props.channelId]), queryFn: ({ signal }) => api<{ active: Run[] }>(`/api/channels/${props.channelId}/agent-runs`, { signal, timeout: 10000 }), refetchInterval: 1000, staleTime: 0 })
const active = computed(() => runs.data.value?.active.filter(run => run.agentId === props.agentId) ?? [])
const working = computed(() => active.value.some(run => run.status === 'running'))
// The composer's activity row owns Stop for a reply here; a reply in a thread is stopped there.
const presence = usePresenceStore()
const replyingHere = computed(() => presence.agentTurnsIn(props.channelId).some(turn => turn.agentId === props.agentId))
const replyingInThread = computed(() => active.value.some(run => run.status === 'running' && run.channelId !== props.channelId))
const queued = computed(() => active.value.filter(run => run.status === 'queued'))
watch(() => active.value.length > 0, value => emit('busy', value), { immediate: true })
const models = computed(() => (state.data.value?.models ?? []).map(model => ({ ...model, label: agentModelLabel(model) })))
const efforts: { value: AgentEffort; label: string }[] = [{ value: 'auto', label: 'Auto' }, { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }]
// Background refreshes keep the menu quiet; only a new search shows progress.
const searching = computed(() => state.isFetching.value && state.isPlaceholderData.value)
const selectedModel = computed(() => state.data.value?.models.find(model => model.value === state.data.value?.selected))
const phone = useMediaQuery('(max-width: 767px), (pointer: coarse)')
const sheetOpen = ref(false)
const groups = computed(() => {
  const byProvider = new Map<string, AgentModelOption[]>()
  for (const model of state.data.value?.models ?? []) byProvider.set(model.provider, [...(byProvider.get(model.provider) ?? []), model])
  return [...byProvider].map(([provider, items]) => ({ provider, items }))
})
async function choose(model: string) { sheetOpen.value = false; if (model !== state.data.value?.selected) await select(model) }
// A deployment-configured model works without any saved provider, so say so instead of asking for one.
const modelStatus = computed(() => {
  if (state.isPending.value) return 'Loading models…'
  if (state.error.value && !state.data.value) return 'Models unavailable'
  const data = state.data.value
  if (data?.deploymentProvider || data?.defaultModel) return data.defaultModel ? `Server default · ${data.defaultModel}` : 'Server default model'
  return 'Connect a provider in Server settings'
})
// Effort is offered unless the catalog says the model cannot reason.
const showEffort = computed(() => Boolean(selectedModel.value) && selectedModel.value?.reasoning !== false)
async function select(model: string, effort?: AgentEffort) {
  if (saving.value) return
  saving.value = true; emit('saving', true)
  try { await api(`/api/channels/${props.channelId}/agent-model`, { method: 'PUT', body: effort ? { effort } : { model } }); await state.refetch() }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { saving.value = false; emit('saving', false) }
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
      <li v-for="run in queued" :key="run.id" class="flex min-w-0 items-center gap-2 text-xs"><UIcon name="i-ph-clock" class="size-3 shrink-0 text-muted" /><span class="min-w-0 flex-1 truncate">{{ displayAgentPrompt(run.prompt) }}</span><UBadge label="Queued" size="xs" color="neutral" variant="subtle" /><UButton v-if="working && run.initiatedBy === session.user?.id" :disabled="disabled || controlling" label="Steer" size="xs" variant="ghost" color="neutral" @click="steer(run)" /></li>
    </ul>
    <LayoutLoadError v-if="runs.error.value" inline message="Agent queue did not refresh." :retry="runs.refetch" />
    <div v-if="!replyingHere" class="flex min-w-0 items-center gap-0.5 px-2 py-1">
      <!-- Same 36px column as the composer's attach button, so both icons line up. -->
      <span class="flex w-9 shrink-0 justify-center"><UIcon name="i-ph-robot" class="size-5 text-muted" /></span>
      <UButton v-if="phone && (models.length || search)" :disabled="disabled || saving" :loading="saving" size="xs" variant="ghost" color="neutral" trailing-icon="i-ph-caret-down" class="min-w-0 flex-1 justify-between" :ui="{ label: 'truncate' }" aria-label="Provider / model" :label="selectedModel ? agentModelLabel(selectedModel) : 'Choose provider / model'" @click="sheetOpen = true" />
      <USelectMenu v-else-if="models.length || search" v-model:search-term="search" :loading="searching" ignore-filter :model-value="state.data.value?.selected ?? undefined" :items="models" value-key="value" virtualize :disabled="disabled || saving" size="xs" variant="ghost" class="min-w-0 flex-1" :ui="{ base: 'min-w-0', value: 'truncate' }" placeholder="Choose provider / model" aria-label="Provider / model" @update:model-value="model => select(model)">
        <template #item-trailing="{ item }"><AgentsModelCapabilities :inputs="item.inputs" :reasoning="item.reasoning" /></template>
      </USelectMenu>
      <span v-else class="min-w-0 flex-1 truncate text-xs text-muted">{{ modelStatus }}</span>
      <UBadge v-if="replyingInThread" label="Replying in thread" icon="i-ph-circle-notch" color="neutral" variant="subtle" size="sm" class="shrink-0" :ui="{ leadingIcon: 'animate-spin' }" />
      <USelect v-if="showEffort && !phone" :model-value="state.data.value?.effort ?? 'auto'" :items="efforts" :disabled="disabled || saving" size="xs" variant="ghost" icon="i-ph-brain" class="w-auto shrink-0" aria-label="Reasoning effort" @update:model-value="(effort: AgentEffort) => select('', effort)" />
      <UButton v-if="state.error.value" icon="i-ph-arrow-clockwise" aria-label="Retry model list" size="xs" variant="ghost" color="neutral" @click="state.refetch()" />
    </div>
    <UDrawer v-model:open="sheetOpen" title="Model" :ui="{ body: 'p-0' }">
      <template #body>
        <div class="sticky top-0 bg-default p-3"><UInput v-model="search" icon="i-ph-magnifying-glass" :loading="searching" placeholder="Search models" class="w-full" size="lg" /></div>
        <div v-if="showEffort" class="px-3 pb-2"><p class="mb-1.5 text-xs font-medium text-muted">Reasoning effort</p><UTabs :model-value="state.data.value?.effort ?? 'auto'" :items="efforts" :content="false" size="sm" class="w-full" @update:model-value="effort => select('', effort as AgentEffort)" /></div>
        <div class="max-h-[60dvh] overflow-y-auto pb-[calc(1rem+var(--df-safe-area-bottom,0px))]">
          <p v-if="!groups.length" class="px-4 py-6 text-sm text-muted">{{ search ? 'No models match.' : modelStatus }}</p>
          <section v-for="group in groups" :key="group.provider">
            <h3 class="px-4 pb-1 pt-3 text-xs font-medium uppercase tracking-wide text-muted">{{ group.provider }}</h3>
            <button v-for="item in group.items" :key="item.value" type="button" class="flex min-h-12 w-full items-center gap-3 px-4 text-start text-sm active:bg-elevated" :aria-pressed="item.value === state.data.value?.selected" @click="choose(item.value)">
              <span class="min-w-0 flex-1">{{ item.label }}</span><AgentsModelCapabilities :inputs="item.inputs" :reasoning="item.reasoning" /><UIcon v-if="item.value === state.data.value?.selected" name="i-ph-check" class="size-5 shrink-0 text-primary" />
            </button>
          </section>
        </div>
      </template>
    </UDrawer>
  </div>
</template>
