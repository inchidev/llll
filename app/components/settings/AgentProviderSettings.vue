<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { agentProviderSchema, agentProviderIds, providerNames, agentModelLabel, type AgentProviderId, type AgentProviderDTO, type AgentProviderModel } from '~~/shared/agent-providers'
const props = defineProps<{ serverId: string; isOwner?: boolean }>()
const noDefault = '__none__'
const { api } = useApi()
const qc = useQueryClient(), toast = useToast()
const editing = shallowRef<AgentProviderDTO | null>(null)
const open = ref(false), busy = ref(false), loadingModels = ref(false), query = ref(''), page = ref(1)
const availableModels = shallowRef<AgentProviderModel[]>([])
const modelError = ref('')
const connection = shallowRef<{ state: string; authorizationUrl: string; expiresAt: number } | null>(null)
const state = reactive({ kind: 'openrouter' as AgentProviderId, name: providerNames.openrouter, enabled: true, apiKey: '', webSearch: false, models: [] as AgentProviderModel[] })
const modelSearch = ref('')
const catalog = useQuery({ queryKey: computed(() => ['agent-providers', props.serverId, query.value, page.value]), queryFn: () => api<{ providers: AgentProviderDTO[]; total: number }>(`/api/servers/${props.serverId}/agent-providers/connections`, { query: { search: query.value, page: page.value } }) })
const modelOptions = useQuery({ queryKey: computed(() => ['agent-provider-model-options', props.serverId, modelSearch.value]), queryFn: () => api<{ models: import('~~/shared/agent-providers').AgentModelOption[]; defaultModel: string | null; deploymentProvider?: string | null }>(`/api/servers/${props.serverId}/agent-providers/model-options`, { query: { search: modelSearch.value } }) })
const connecting = useQuery({ queryKey: computed(() => ['agent-provider-connecting', props.serverId, editing.value?.id]), queryFn: () => api<{ provider: AgentProviderDTO }>(`/api/servers/${props.serverId}/agent-providers/${editing.value!.id}`), enabled: computed(() => Boolean(connection.value && editing.value)), refetchInterval: 2000 })
const kinds = agentProviderIds.map(value => ({ value, label: providerNames[value] }))
const visible = computed(() => catalog.data.value?.providers ?? [])
const modelItems = computed(() => [...new Map([...state.models, ...availableModels.value].map(m => [m.id, { ...m, label: (m.label ?? m.id) + (m.tools === false ? ' (AI functions only)' : '') }])).values()])
const selectedModels = computed({ get: () => state.models.map(m => m.id), set: (ids: string[]) => { state.models = ids.flatMap(id => { const m = [...state.models, ...availableModels.value].find(m => m.id === id); return m ? [{ id: m.id, label: m.label, api: m.api, tools: m.tools }] : [] }) } })
watch(() => state.kind, (kind, previous) => { if (!state.name.trim() || state.name === providerNames[previous]) state.name = providerNames[kind] })
watch(query, () => { page.value = 1 })
function edit(provider: AgentProviderDTO | null = null) {
  editing.value = provider; connection.value = null; availableModels.value = []; modelError.value = ''
  Object.assign(state, { kind: provider?.kind ?? 'openrouter', name: provider?.name ?? providerNames.openrouter, enabled: provider?.enabled ?? true, apiKey: '', webSearch: provider?.webSearch ?? false, models: provider?.models.map(m => ({ ...m })) ?? [] })
  open.value = true
  if (provider?.configured) void loadModels()
}
async function refresh() { await Promise.all([catalog.refetch(), qc.invalidateQueries({ queryKey: ['agent-model'] }), qc.invalidateQueries({ queryKey: ['health'] }), qc.invalidateQueries({ queryKey: ['agent-provider-model-options'] }), qc.invalidateQueries({ queryKey: ['ai-functions'] })]) }
async function loadModels() {
  loadingModels.value = true; modelError.value = ''
  try {
    const result = await api<{ models: AgentProviderModel[] }>(`/api/servers/${props.serverId}/agent-providers/models`, { method: 'POST', body: { kind: state.kind, connectionId: editing.value?.id, apiKey: state.apiKey || undefined } })
    availableModels.value = result.models
    state.models = state.models.map(model => result.models.find(option => option.id === model.id) ?? model)
    if (!result.models.length) modelError.value = 'No compatible models are available for this connection.'
  } catch (error) { modelError.value = errorMessage(error) }
  finally { loadingModels.value = false }
}
async function persist() {
  const id = editing.value?.id ?? crypto.randomUUID()
  const result = await api<{ provider: AgentProviderDTO }>(`/api/servers/${props.serverId}/agent-providers/${id}`, { method: 'PUT', body: { ...state, name: state.name.trim() || providerNames[state.kind], apiKey: state.apiKey || undefined } })
  state.apiKey = ''; await refresh()
  editing.value = result.provider
  return id
}
async function save() {
  if (busy.value) return
  busy.value = true
  try { await persist(); open.value = false }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { busy.value = false }
}
const local = computed(() => import.meta.client && location.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(location.hostname))
async function connectChatGPT() {
  if (busy.value) return
  const popup = local.value ? window.open('about:blank', '_blank') : null
  busy.value = true
  try {
    const id = await persist()
    const result = await api<{ state: string; authorizationUrl: string; expiresAt: number }>(`/api/servers/${props.serverId}/agent-providers/${id}/connect`, { method: 'POST', body: { local: local.value } })
    connection.value = result
    if (popup) popup.location.href = result.authorizationUrl
  } catch (error) { popup?.close(); toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { busy.value = false }
}
const helperCommand = computed(() => connection.value && import.meta.client ? `node connect-chatgpt.mjs '${location.origin}' '${connection.value.authorizationUrl}'` : '')
watch(() => connecting.data.value, value => {
  if (!connection.value || !editing.value) return
  if (connection.value.expiresAt < Date.now()) { connection.value = null; toast.add({ title: 'Sign-in expired', description: 'Continue with ChatGPT again.', color: 'warning' }); return }
  const provider = value?.provider
  if (provider?.configured && provider.account && provider.connectedAt !== editing.value.connectedAt) { connection.value = null; editing.value = provider; state.models = provider.models; void Promise.all([loadModels(), refresh()]); toast.add({ title: 'ChatGPT connected', color: 'success' }) }
})
async function remove() {
  if (!editing.value || busy.value) return
  busy.value = true
  try {
    const result = await api<{ revoked: boolean }>(`/api/servers/${props.serverId}/agent-providers/${editing.value.id}`, { method: 'DELETE' })
    open.value = false; await refresh()
    if (!result.revoked) toast.add({ title: 'Removed from L4', description: 'Remote revocation was not confirmed. Disconnect L4 in ChatGPT settings.', color: 'warning' })
  } catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { busy.value = false }
}
async function setDefault(model: string) {
  try { await api(`/api/servers/${props.serverId}/agent-providers/default`, { method: 'PUT', body: { model: model === noDefault ? '' : model } }); await refresh() }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
}
watch(open, value => { if (!value) { state.apiKey = ''; connection.value = null } })
watch(() => state.kind, () => { if (!editing.value) { state.models = []; availableModels.value = []; modelError.value = '' } })
</script>

<template>
  <section class="space-y-5" aria-label="Model providers">
    <SettingsAiFunctionSettings v-if="isOwner" :server-id="serverId" />
    <section class="space-y-3 border-b border-default pb-5" aria-label="Model defaults">
      <h2 class="text-sm font-medium text-highlighted">Model defaults</h2>
      <UFormField v-if="isOwner" label="Default model" description="Choose explicitly. Connecting a provider never selects a model or authorizes a paid fallback.">
        <USelectMenu v-model:search-term="modelSearch" :loading="modelOptions.isPending.value" :disabled="!modelOptions.data.value?.models.length && !modelSearch" placeholder="Choose a default model" ignore-filter :model-value="modelOptions.data.value?.defaultModel ?? noDefault" value-key="value" :items="[{ value: noDefault, label: 'No default model' }, ...(modelOptions.data.value?.models ?? []).map(model => ({ value: model.value, label: agentModelLabel(model) }))]" class="w-full" virtualize @update:model-value="setDefault" />
      </UFormField>
    </section>
    <UAlert v-if="modelOptions.data.value?.deploymentProvider" color="neutral" :title="modelOptions.data.value.deploymentProvider" description="Available through this Server’s deployment. Account access, quota and model compatibility are checked when you run it. Select a model explicitly; no default is enabled automatically." />
    <div class="flex flex-wrap items-center justify-between gap-3"><p class="text-sm text-muted">Named connections for Agents and AI functions.</p><UButton v-if="isOwner" label="Add provider" icon="i-ph-plus" @click="edit()" /></div>
    <UInput v-model="query" icon="i-ph-magnifying-glass" placeholder="Search providers" aria-label="Search providers" class="w-full" />
    <LayoutLoadError v-if="catalog.error.value" inline message="Providers did not load." :retry="catalog.refetch" />
    <LayoutEmptyState v-else-if="!catalog.isPending.value && !visible.length" icon="i-ph-plugs" title="No named connections" description="Connect a model service to use it with Pi." />
    <ul v-else class="divide-y divide-default rounded-lg border border-default">
      <li v-for="provider in visible" :key="provider.id" class="flex min-h-16 items-center gap-3 p-3">
        <UIcon :name="provider.kind === 'anthropic' ? 'i-ph-sparkle' : 'i-ph-plugs-connected'" class="size-5 shrink-0 text-muted" />
        <div class="min-w-0 flex-1"><span class="block truncate text-sm font-medium">{{ provider.name }}</span><span class="block truncate text-xs text-muted">{{ providerNames[provider.kind] }} · {{ provider.account || provider.keyPreview || (provider.configured ? 'Connected' : 'Not connected') }}</span><span class="text-xs text-muted">{{ provider.enabled ? `${provider.models.length} models` : 'Disabled' }}{{ provider.personal ? ' · Your account only' : '' }}</span></div>
        <UButton v-if="isOwner" label="Configure" size="sm" color="neutral" variant="outline" @click="edit(provider)" />
      </li>
    </ul>
    <UPagination v-if="(catalog.data.value?.total ?? 0) > 15" v-model:page="page" :items-per-page="15" :total="catalog.data.value?.total ?? 0" />
  </section>
  <UModal v-model:open="open" :title="editing ? `Configure ${editing.name}` : 'Add provider'" description="Connect an account and choose models for Agents and AI functions.">
    <template #body>
      <UForm id="agent-provider-form" :schema="agentProviderSchema.omit({ apiKey: true })" :state="state" class="space-y-4" @submit="save">
        <UFormField name="kind" label="Provider"><USelect v-model="state.kind" :items="kinds" :disabled="Boolean(editing)" class="w-full" /></UFormField>
        <UFormField name="name" label="Connection name" description="Distinguish work, personal, or other accounts."><UInput v-model="state.name" :placeholder="providerNames[state.kind]" class="w-full" /></UFormField>
        <template v-if="state.kind === 'chatgpt'">
          <p class="text-sm text-muted">{{ editing?.account ? `Connected as ${editing.account}.` : 'Use your ChatGPT plan with Pi.' }} This connection is available only for your requests.</p>
          <UButton label="Continue with ChatGPT" color="neutral" variant="outline" :loading="busy" @click="connectChatGPT" />
          <template v-if="connection">
            <div v-if="local" class="space-y-2"><p class="text-sm text-muted">Finish signing in in the new tab. This page will update automatically.</p><UButton :to="connection.authorizationUrl" target="_blank" label="Open ChatGPT sign-in" color="neutral" variant="link" /></div>
            <div v-else class="space-y-3">
              <p class="text-sm text-muted">OpenAI returns sign-in to your computer. Download the helper, then run this command in its folder. It opens your browser and returns the connection to this Server.</p>
              <UButton to="/connect-chatgpt.mjs" download="connect-chatgpt.mjs" label="Download sign-in helper" icon="i-ph-download" color="neutral" variant="outline" />
              <pre class="max-h-32 overflow-auto rounded-md bg-elevated p-3 text-xs whitespace-pre-wrap break-all">{{ helperCommand }}</pre>
            </div>
          </template>
        </template>
        <UFormField v-else name="apiKey" label="API key" :description="editing?.configured ? `Saved: ${editing.keyPreview || '••••••••'}. Leave blank to keep it.` : 'Paste the key from your provider account.'"><UInput v-model="state.apiKey" type="password" autocomplete="new-password" :placeholder="editing?.keyPreview" class="w-full" /></UFormField>
        <template v-if="state.kind !== 'chatgpt' || editing?.configured">
          <UFormField name="models" label="Models" description="Search the provider catalog and choose which models are available.">
            <USelectMenu v-model="selectedModels" :items="modelItems" value-key="id" multiple virtualize placeholder="Choose models" class="w-full" :loading="loadingModels" :search-input="{ placeholder: 'Search model names…' }" />
          </UFormField>
          <UButton label="Load models" icon="i-ph-arrow-clockwise" color="neutral" variant="ghost" :loading="loadingModels" @click="loadModels" />
          <p v-if="modelError" class="text-sm text-error" role="alert">{{ modelError }}</p>
          <UFormField name="enabled" label="Available to agents"><USwitch v-model="state.enabled" /></UFormField>
        </template>
        <UFormField v-if="state.kind === 'openrouter'" name="webSearch" label="Web search" description="Allow agents with Browse Web permission to search. Additional OpenRouter charges apply."><USwitch v-model="state.webSearch" /></UFormField>
      </UForm>
    </template>
    <template #footer><UButton v-if="editing" label="Remove connection" color="error" variant="ghost" :disabled="busy" class="me-auto" @click="remove" /><UButton label="Cancel" color="neutral" variant="ghost" @click="open = false" /><UButton type="submit" form="agent-provider-form" label="Save" :disabled="!state.models.length && state.kind !== 'chatgpt'" :loading="busy" /></template>
  </UModal>
</template>
