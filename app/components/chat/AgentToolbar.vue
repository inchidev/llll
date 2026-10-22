<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { AgentProviderCatalog } from '~~/shared/agent-providers'
import type { ClientMsg } from '~~/shared/types'
const props = defineProps<{ channelId: string; agentId: string; send: (message: ClientMsg) => void; disabled?: boolean }>()
const mode = defineModel<'queue' | 'steer'>({ default: 'queue' })
const emit = defineEmits<{ busy: [value: boolean]; saving: [value: boolean] }>()
const { api } = useApi()
const toast = useToast()
const saving = ref(false)
type State = AgentProviderCatalog & { selected: string | null; active: Array<{ agentId: string; status: string }> }
const state = useQuery({ queryKey: computed(() => ['agent-model', props.channelId]), queryFn: ({ signal }) => api<State>(`/api/channels/${props.channelId}/agent-model`, { signal, timeout: 10000 }), refetchInterval: 2500 })
const active = computed(() => state.data.value?.active.filter(run => run.agentId === props.agentId) ?? [])
watch(() => active.value.length > 0, value => emit('busy', value), { immediate: true })
const models = computed(() => state.data.value?.models ?? [])
const provider = computed(() => models.value.find(model => model.value === state.data.value?.selected)?.provider)
const providers = computed(() => [...new Set(models.value.map(model => model.provider))])
const modelItems = computed(() => models.value.filter(model => model.provider === provider.value).map(model => ({ label: model.label, value: model.value })))
async function select(model: string) {
  if (saving.value) return
  saving.value = true; emit('saving', true)
  try {
    await api(`/api/channels/${props.channelId}/agent-model`, { method: 'PUT', body: { model } })
    await state.refetch()
  } catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { saving.value = false; emit('saving', false) }
}
function selectProvider(value: string) { const model = models.value.find(model => model.provider === value); if (model) void select(model.value) }
</script>

<template>
  <div class="flex flex-wrap items-center gap-1 border-b border-default px-2 py-1.5" role="group" aria-label="Agent controls">
    <UIcon name="i-ph-robot" class="mx-1 size-4 shrink-0 text-muted" />
    <template v-if="models.length">
      <USelect :model-value="provider" :items="providers" :disabled="disabled || saving" size="xs" variant="ghost" class="max-w-36" placeholder="Choose provider" aria-label="Model provider" @update:model-value="selectProvider" />
      <USelect :model-value="state.data.value?.selected ?? undefined" :items="modelItems" :disabled="disabled || saving" size="xs" variant="ghost" class="min-w-28 max-w-64 flex-1" placeholder="Choose model" aria-label="Agent model" @update:model-value="select" />
    </template>
    <span v-else class="text-xs text-muted">{{ state.error.value ? 'Models unavailable' : 'Configure a provider in Server settings' }}</span>
    <UTooltip text="Queue waits for the current run. Steer adds instructions to your active run at its next tool boundary.">
      <USelect v-model="mode" :items="[{ label: 'Queue', value: 'queue' }, { label: 'Steer', value: 'steer' }]" :disabled="disabled" size="xs" variant="ghost" class="ms-auto w-24" aria-label="Agent message mode" />
    </UTooltip>
    <UBadge v-if="active.length > 1" :label="`${active.length - 1} queued`" color="neutral" size="xs" variant="subtle" />
    <UButton icon="i-ph-stop-fill" label="Stop" :disabled="!active.length || disabled" size="xs" variant="ghost" color="neutral" @click="send({ t: 'agent.control', agentId, action: 'stop' })" />
    <UButton v-if="state.error.value" icon="i-ph-arrow-clockwise" aria-label="Retry model list" size="xs" variant="ghost" color="neutral" @click="state.refetch()" />
  </div>
</template>
