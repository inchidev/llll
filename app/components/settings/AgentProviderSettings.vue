<script setup lang="ts">
import SettingsEditor from './SettingsEditor.vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { agentProviderSchema, agentProviderIds, providerNames, agentModelLabel, type AgentProviderId, type AgentProviderDTO, type AgentProviderModel } from '~~/shared/agent-providers'
const props = withDefaults(defineProps<{ serverId: string; isOwner?: boolean; view?: 'providers' | 'defaults' }>(), { view: 'providers' })
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
const providerCards: Record<AgentProviderId, { icon: string; description: string }> = {
  openrouter: { icon: 'i-ph-shuffle', description: 'Hundreds of models with one API key' },
  anthropic: { icon: 'i-ph-asterisk', description: 'Claude models with an Anthropic API key' },
  chatgpt: { icon: 'i-ph-open-ai-logo', description: 'Your ChatGPT plan, for your own requests' },
}
const kinds = agentProviderIds.map(value => ({ value, label: providerNames[value], ...providerCards[value] }))
const visible = computed(() => catalog.data.value?.providers ?? [])
// The catalog is for adding; the chosen models are listed below it, each removable.
const modelItems = computed(() => availableModels.value.filter(m => !state.models.some(chosen => chosen.id === m.id)).map(m => ({ ...m, label: m.label ?? m.id })))
const addModel = ref<string>()
watch(addModel, id => {
  const model = availableModels.value.find(m => m.id === id)
  if (model) state.models = [...state.models, { ...model }]
  addModel.value = undefined
})
function removeModel(id: string) { state.models = state.models.filter(m => m.id !== id) }
watch(() => state.kind, (kind, previous) => { if (!state.name.trim() || state.name === providerNames[previous]) state.name = providerNames[kind] })
watch(query, () => { page.value = 1 })
function edit(provider: AgentProviderDTO | null = null) {
  editing.value = provider; connection.value = null; availableModels.value = []; modelError.value = ''
  Object.assign(state, { kind: provider?.kind ?? 'openrouter', name: provider?.name ?? providerNames.openrouter, enabled: provider?.enabled ?? true, apiKey: '', webSearch: provider?.webSearch ?? false, models: provider?.models.map(m => ({ ...m })) ?? [] })
  open.value = true
  if (provider?.configured) void loadModels()
}
defineExpose({ openCreate: () => edit() })
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
// One pasteable command: it fetches this Server's helper and runs it, so nothing needs downloading first.
const helperCommand = computed(() => connection.value && import.meta.client ? `curl -fsSL '${location.origin}/connect-chatgpt.mjs' | node --input-type=module - '${location.origin}' '${connection.value.authorizationUrl}'` : '')
const copied = ref(false)
async function copyCommand() {
  try { await navigator.clipboard.writeText(helperCommand.value); copied.value = true; setTimeout(() => { copied.value = false }, 2000) }
  catch { toast.add({ title: 'Copy failed. Select the command and copy it.', color: 'error' }) }
}
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
    <template v-if="view === 'defaults'">
    <SettingsAiFunctionSettings v-if="isOwner" :server-id="serverId" />
    <section class="space-y-3 border-b border-default pb-5" aria-label="Model defaults">
      <h2 class="text-sm font-medium text-highlighted">Model defaults</h2>
      <UFormField v-if="isOwner" label="Default model" description="Choose explicitly. Connecting a provider never selects a model or authorizes a paid fallback.">
        <USelectMenu v-model:search-term="modelSearch" :loading="modelOptions.isPending.value" :disabled="!modelOptions.data.value?.models.length && !modelSearch" placeholder="Choose a default model" ignore-filter :model-value="modelOptions.data.value?.defaultModel ?? noDefault" value-key="value" :items="[{ value: noDefault, label: 'No default model' }, ...(modelOptions.data.value?.models ?? []).map(model => ({ value: model.value, label: agentModelLabel(model) }))]" class="w-full" virtualize @update:model-value="setDefault" />
      </UFormField>
    </section>
    </template>
    <template v-else>
    <UAlert v-if="modelOptions.data.value?.deploymentProvider" color="neutral" :title="modelOptions.data.value.deploymentProvider" description="Available through this Server’s deployment. Account access, quota and model compatibility are checked when you run it. Select a model explicitly; no default is enabled automatically." />
    <UInput v-model="query" icon="i-ph-magnifying-glass" placeholder="Search providers" aria-label="Search providers" class="w-full" />
    <LayoutLoadError v-if="catalog.error.value" inline message="Providers did not load." :retry="catalog.refetch" />
    <LayoutEmptyState v-else-if="!catalog.isPending.value && !visible.length" icon="i-ph-plugs" title="No model providers yet" description="Add OpenRouter, an Anthropic API key or ChatGPT so agents can reply." />
    <SettingsList v-else :items="visible" :item-key="provider => provider.id" :search-text="provider => provider.name" :search-from="Infinity" :noun="['provider', 'providers']" @select="edit"><template #row="{ item: provider }"><span class="flex size-8 shrink-0 items-center justify-center rounded-md bg-elevated text-muted"><UIcon :name="provider.kind === 'anthropic' ? 'i-ph-sparkle' : 'i-ph-plugs-connected'" class="size-4" /></span><span class="min-w-0 flex-1"><span class="block truncate text-sm font-medium">{{ provider.name }}</span><span class="block truncate text-xs text-muted">{{ providerNames[provider.kind] }} · {{ provider.account || provider.keyPreview || (provider.configured ? 'Connected' : 'Not connected') }} · {{ provider.enabled ? `${provider.models.length} models` : 'Disabled' }}{{ provider.personal ? ' · Your account only' : '' }}</span></span></template></SettingsList>
    <UPagination v-if="(catalog.data.value?.total ?? 0) > 15" v-model:page="page" :items-per-page="15" :total="catalog.data.value?.total ?? 0" />
    </template>
  </section>
  <SettingsEditor v-model:open="open" back="Models" :title="editing ? `Configure ${editing.name}` : 'Add provider'" description="Connect an account and choose models for Agents and AI functions.">
    <template #body>
      <UForm id="agent-provider-form" :schema="agentProviderSchema.omit({ apiKey: true })" :state="state" class="space-y-4" @submit="save">
        <UFormField name="kind" label="Provider">
          <div v-if="!editing" class="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Provider">
            <button v-for="kind in kinds" :key="kind.value" type="button" role="radio" :aria-checked="state.kind === kind.value" class="flex flex-col items-start gap-1.5 rounded-md border p-3 text-start transition-colors" :class="state.kind === kind.value ? 'border-primary bg-elevated' : 'border-default hover:bg-elevated/50'" @click="state.kind = kind.value">
              <UIcon :name="kind.icon" class="size-6 text-highlighted" />
              <span class="text-sm font-medium text-highlighted">{{ kind.label }}</span>
              <span class="text-xs text-muted">{{ kind.description }}</span>
            </button>
          </div>
          <div v-else class="flex items-center gap-2 text-sm"><UIcon :name="providerCards[state.kind].icon" class="size-5" /><span>{{ providerNames[state.kind] }}</span></div>
        </UFormField>
        <UFormField name="name" label="Connection name" description="Distinguish work, personal, or other accounts. Left empty, it uses the provider name."><UInput v-model="state.name" class="w-full" /></UFormField>
        <template v-if="state.kind === 'chatgpt'">
          <p class="text-sm text-muted">{{ editing?.account ? `Connected as ${editing.account}.` : 'Use your ChatGPT plan with Pi.' }} This connection is available only for your requests.</p>
          <UButton label="Continue with ChatGPT" color="neutral" variant="outline" :loading="busy" @click="connectChatGPT" />
          <template v-if="connection">
            <div v-if="local" class="space-y-2"><p class="text-sm text-muted">Finish signing in in the new tab. This page will update automatically.</p><UButton :to="connection.authorizationUrl" target="_blank" label="Open ChatGPT sign-in" color="neutral" variant="link" /></div>
            <div v-else class="space-y-3 rounded-md border border-default p-3">
              <p class="text-sm font-medium text-highlighted">Finish sign-in from your computer</p>
              <p class="text-sm text-muted">OpenAI only returns ChatGPT sign-in to the computer you sign in on, not to a website. A small helper from this Server receives it there and passes the connection back. It needs Node.js 24 and stops after sign-in.</p>
              <ol class="list-decimal space-y-1 ps-5 text-sm text-default">
                <li>Copy the command.</li>
                <li>Paste it into Terminal and press Return. Your browser opens ChatGPT.</li>
                <li>Approve access. This page updates by itself.</li>
              </ol>
              <div class="flex flex-wrap items-center gap-2">
                <UButton :label="copied ? 'Copied' : 'Copy command'" :icon="copied ? 'i-ph-check' : 'i-ph-copy'" color="neutral" @click="copyCommand" />
                <UButton to="/connect-chatgpt.mjs" download="connect-chatgpt.mjs" label="Download helper instead" icon="i-ph-download" color="neutral" variant="link" />
              </div>
              <details class="text-xs text-muted"><summary class="cursor-pointer">Show command</summary><pre class="mt-2 max-h-32 overflow-auto rounded-md bg-elevated p-3 whitespace-pre-wrap break-all">{{ helperCommand }}</pre></details>
              <p class="text-xs text-muted">The sign-in link expires in 10 minutes.</p>
            </div>
          </template>
        </template>
        <UFormField v-else name="apiKey" label="API key" :description="editing?.configured ? `Saved: ${editing.keyPreview || '••••••••'}. Leave blank to keep it.` : 'Paste the key from your provider account.'"><UInput v-model="state.apiKey" type="password" autocomplete="new-password" :placeholder="editing?.keyPreview" class="w-full" /></UFormField>
        <template v-if="state.kind !== 'chatgpt' || editing?.configured">
          <UFormField name="models" label="Models" description="Models listed here appear in the model picker of agent conversations and AI functions. Models without tool support are offered to AI functions only.">
            <div class="flex gap-2">
              <USelectMenu v-model="addModel" :items="modelItems" value-key="id" virtualize placeholder="Add a model…" class="min-w-0 flex-1" :loading="loadingModels" :disabled="!availableModels.length" :search-input="{ placeholder: 'Search model names…' }">
                <template #item-trailing="{ item }"><AgentsModelCapabilities :inputs="item.inputs" :tools="item.tools" :reasoning="item.reasoning" /></template>
              </USelectMenu>
              <UButton icon="i-ph-arrow-clockwise" aria-label="Reload provider catalog" color="neutral" variant="ghost" :loading="loadingModels" @click="loadModels" />
            </div>
          </UFormField>
          <ul v-if="state.models.length" class="divide-y divide-default rounded-md border border-default" aria-label="Chosen models">
            <li v-for="model in state.models" :key="model.id" class="flex min-h-10 items-center gap-2 py-1.5 pe-1 ps-3 text-sm">
              <span class="min-w-0 flex-1 truncate" :title="model.id">{{ model.label ?? model.id }}</span>
              <AgentsModelCapabilities :inputs="model.inputs" :tools="model.tools" :reasoning="model.reasoning" />
              <UButton icon="i-ph-x" :aria-label="`Remove ${model.label ?? model.id}`" size="xs" color="neutral" variant="ghost" @click="removeModel(model.id)" />
            </li>
          </ul>
          <p v-else class="text-sm text-muted">No models chosen yet.</p>
          <p v-if="modelError" class="text-sm text-error" role="alert">{{ modelError }}</p>
          <UFormField name="enabled" label="Available to agents"><USwitch v-model="state.enabled" /></UFormField>
        </template>
        <UFormField v-if="state.kind === 'openrouter'" name="webSearch" label="Web search" description="Allow agents with Browse Web permission to search. Additional OpenRouter charges apply."><USwitch v-model="state.webSearch" /></UFormField>
      </UForm>
    </template>
    <template #footer><UButton v-if="editing" label="Remove connection" color="error" variant="ghost" :disabled="busy" class="me-auto" @click="remove" /><UButton label="Cancel" color="neutral" variant="ghost" @click="open = false" /><UButton type="submit" form="agent-provider-form" label="Save" :disabled="!state.models.length && state.kind !== 'chatgpt'" :loading="busy" /></template>
  </SettingsEditor>
</template>
