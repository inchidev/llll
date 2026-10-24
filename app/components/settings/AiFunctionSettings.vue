<script setup lang="ts">
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/vue-query'
import type { AiFunctionDTO, AiFunctionId } from '~~/shared/ai-functions'
import { agentModelLabel, type AgentModelOption } from '~~/shared/agent-providers'

const props = defineProps<{ serverId: string }>()
const disabledModel = '__disabled__'
const { api } = useApi()
const qc = useQueryClient(), toast = useToast()
const search = ref(''), saving = ref<AiFunctionId | null>(null)
const functions = useQuery({
  queryKey: computed(() => ['ai-functions', props.serverId, search.value]),
  queryFn: () => api<{ functions: AiFunctionDTO[]; models: Array<AgentModelOption & { webSearch: boolean }>; hasMore: boolean }>(`/api/servers/${props.serverId}/ai-functions`, { query: { search: search.value } }),
  placeholderData: keepPreviousData,
})
function items(entry: AiFunctionDTO) {
  const models = (functions.data.value?.models ?? []).filter(model => entry.id !== 'web.search' || model.webSearch)
  return [{ value: disabledModel, label: 'Disabled' },
    ...(entry.model && !models.some(model => model.value === entry.model) ? [{ value: entry.model, label: `${entry.model} (unavailable)` }] : []),
    ...models.map(model => ({ value: model.value, label: agentModelLabel(model) })),
  ]
}
async function save(id: AiFunctionId, model: string) {
  if (saving.value) return
  saving.value = id
  try {
    await api(`/api/servers/${props.serverId}/ai-functions/${id}`, { method: 'PUT', body: { model: model === disabledModel ? null : model } })
    await qc.invalidateQueries({ queryKey: ['ai-functions', props.serverId] })
    toast.add({ title: 'AI function updated', color: 'success' })
  } catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { saving.value = null }
}
</script>

<template>
  <section class="space-y-4 border-b border-default pb-5" aria-label="AI functions">
    <div><h2 class="text-sm font-medium text-highlighted">AI functions</h2><p class="mt-1 text-sm text-muted">Assign a connection and model to each job. These choices do not use an Agent or inherit its default. Personal connections serve only their account holder’s requests.</p></div>
    <LayoutLoadError v-if="functions.error.value" inline message="AI functions did not load." :retry="functions.refetch" />
    <UInput v-model="search" aria-label="Search models for AI functions" placeholder="Search connected models" icon="i-ph-magnifying-glass" class="w-full" />
    <UFormField v-for="entry in functions.data.value?.functions ?? []" :key="entry.id" :label="entry.label" :description="entry.description" :hint="entry.invalid ? 'Choose a model again' : entry.model && !entry.available ? 'Unavailable' : undefined">
      <USelectMenu :aria-label="entry.label" :model-value="entry.model ?? disabledModel" :items="items(entry)" value-key="value" ignore-filter virtualize :loading="saving === entry.id" :disabled="Boolean(saving)" class="w-full" @update:model-value="save(entry.id, $event)" />
    </UFormField>
    <p v-if="functions.data.value?.hasMore" class="text-xs text-muted">Search to find more models.</p>
    <p class="text-xs text-muted">Calls send the requesting Member’s permitted context to the selected provider. No model is selected automatically. Thread creation keeps a message-based title when title generation is disabled or fails.</p>
  </section>
</template>
