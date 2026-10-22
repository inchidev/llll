<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { agentProviderSchema, type AgentProviderCatalog, type AgentProviderDTO, type AgentProviderModel } from '~~/shared/agent-providers'
const props = defineProps<{ serverId: string; isOwner?: boolean }>()
const { api } = useApi()
const qc = useQueryClient()
const toast = useToast()
const editing = ref<AgentProviderDTO | null>(null)
const open = ref(false)
const busy = ref(false)
const state = reactive({ enabled: true, apiKey: '', webSearch: false, models: [{ id: '', api: 'chat' }] as AgentProviderModel[] })
const catalog = useQuery({ queryKey: computed(() => ['agent-providers', props.serverId]), queryFn: () => api<AgentProviderCatalog>(`/api/servers/${props.serverId}/agent-providers`) })
const protocols = [{ label: 'Chat Completions', value: 'chat' }, { label: 'Responses', value: 'responses' }, { label: 'Anthropic Messages', value: 'anthropic' }]
function edit(provider: AgentProviderDTO) {
  editing.value = provider
  state.apiKey = ''; state.enabled = provider.configured ? provider.enabled : true; state.webSearch = provider.webSearch
  state.models = provider.models.length ? provider.models.map(model => ({ ...model })) : [{ id: '', api: provider.id === 'anthropic' ? 'anthropic' : 'chat' }]
  open.value = true
}
async function refresh() { await Promise.all([catalog.refetch(), qc.invalidateQueries({ queryKey: ['agent-model'] }), qc.invalidateQueries({ queryKey: ['health'] })]) }
async function save() {
  if (!editing.value || busy.value) return
  busy.value = true
  try {
    await api(`/api/servers/${props.serverId}/agent-providers/${editing.value.id}`, { method: 'PUT', body: { ...state, apiKey: state.apiKey || undefined } })
    state.apiKey = ''; open.value = false; await refresh()
  } catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { busy.value = false }
}
async function setDefault(model: string) {
  try { await api(`/api/servers/${props.serverId}/agent-providers/default`, { method: 'PUT', body: { model } }); await refresh() }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
}
async function importKey() {
  busy.value = true
  try { await api(`/api/servers/${props.serverId}/agent-providers/import`, { method: 'POST', body: { webSearch: true } }); await refresh() }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { busy.value = false }
}
watch(open, value => { if (!value) state.apiKey = '' })
</script>

<template>
  <section class="mt-8 space-y-3" aria-label="Model providers">
    <div><h3 class="text-base font-semibold text-highlighted">Model providers</h3><p class="mt-1 text-sm text-muted">Pi runs every agent. Choose which model services it can use.</p></div>
    <LayoutLoadError v-if="catalog.error.value" inline message="Providers did not load." :retry="catalog.refetch" />
    <ul class="divide-y divide-default rounded-lg border border-default">
      <li v-for="provider in catalog.data.value?.providers ?? []" :key="provider.id" class="flex min-h-16 items-center gap-3 px-3 py-3">
        <UIcon :name="provider.id === 'anthropic' ? 'i-ph-sparkle' : 'i-ph-plugs-connected'" class="size-5 text-muted" />
        <div class="min-w-0 flex-1"><span class="block text-sm font-medium">{{ provider.name }}</span><span class="text-xs text-muted">{{ provider.subscription ? 'Go subscription · API key' : 'API key' }} · {{ provider.configured ? (provider.enabled ? `${provider.models.length} model${provider.models.length === 1 ? '' : 's'}` : 'Disabled') : 'Not connected' }}</span></div>
        <UButton v-if="isOwner" :label="provider.configured ? 'Configure' : 'Connect'" size="sm" color="neutral" variant="outline" @click="edit(provider)" />
      </li>
    </ul>
    <UFormField v-if="isOwner && catalog.data.value?.models.length" label="Default model" description="Used by agents without a conversation override.">
      <USelect :model-value="catalog.data.value.defaultModel ?? undefined" :items="catalog.data.value.models.map(model => ({ value: model.value, label: `${model.provider} · ${model.label}` }))" class="w-full" @update:model-value="setDefault" />
    </UFormField>
    <template v-if="isOwner && catalog.data.value?.canImportOpenRouter">
      <UButton label="Import OpenRouter from deployment" icon="i-ph-download-simple" color="neutral" variant="outline" :loading="busy" @click="importKey" />
      <p class="text-xs text-muted">Stores the existing key encrypted in this Server and enables web search. Search is billed by OpenRouter.</p>
    </template>
    <p v-if="isOwner" class="text-xs text-muted">Provider keys are encrypted and never sent to clients or compute. Claude Pro/Max sign-in is unavailable for embedded Pi; connect Claude with an API key.</p>
  </section>
  <UModal v-model:open="open" :title="editing?.name ?? 'Provider'" description="Connect models for this Server. Blank key keeps the saved credential.">
    <template #body>
      <UForm id="agent-provider-form" :schema="agentProviderSchema.omit({ apiKey: true })" :state="state" class="space-y-4" @submit="save">
        <UFormField name="enabled" label="Available to agents"><USwitch v-model="state.enabled" /></UFormField>
        <UFormField name="apiKey" label="API key" :required="!editing?.configured" :description="editing?.configured ? 'A key is saved. Enter a new one to replace it.' : undefined"><UInput v-model="state.apiKey" type="password" autocomplete="new-password" class="w-full" /></UFormField>
        <fieldset class="space-y-2"><legend class="mb-2 text-sm font-medium">Models</legend>
          <div v-for="(model, index) in state.models" :key="index" class="flex items-end gap-2">
            <UFormField :name="`models.${index}.id`" label="Model ID" class="min-w-0 flex-1"><UInput v-model="model.id" placeholder="Exact provider model ID" class="w-full" /></UFormField>
            <UFormField v-if="editing?.id === 'opencode' || editing?.id === 'opencode-go'" :name="`models.${index}.api`" label="API"><USelect v-model="model.api" :items="protocols" class="w-36" /></UFormField>
            <UButton icon="i-ph-x" aria-label="Remove model" color="neutral" variant="ghost" :disabled="state.models.length === 1" @click="state.models.splice(index, 1)" />
          </div>
          <UButton v-if="state.models.length < 30" label="Add model" icon="i-ph-plus" color="neutral" variant="ghost" size="sm" @click="state.models.push({ id: '', api: editing?.id === 'anthropic' ? 'anthropic' : 'chat' })" />
        </fieldset>
        <UFormField v-if="editing?.id === 'openrouter'" name="webSearch" label="Web search" description="Allow agents with Browse Web permission to search through OpenRouter. Additional search charges apply."><USwitch v-model="state.webSearch" /></UFormField>
      </UForm>
    </template>
    <template #footer><UButton label="Cancel" color="neutral" variant="ghost" @click="open = false" /><UButton type="submit" form="agent-provider-form" label="Save" :loading="busy" /></template>
  </UModal>
</template>
