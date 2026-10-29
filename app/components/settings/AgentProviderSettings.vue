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
const state = reactive({ kind: 'openrouter' as AgentProviderId, name: providerNames.openrouter, enabled: true, apiKey: '', webSearch: false, shared: false, models: [] as AgentProviderModel[] })
const modelSearch = ref('')
const catalog = useQuery({ queryKey: computed(() => ['agent-providers', props.serverId, query.value, page.value]), queryFn: () => api<{ providers: AgentProviderDTO[]; total: number }>(`/api/servers/${props.serverId}/agent-providers/connections`, { query: { search: query.value, page: page.value } }) })
const modelOptions = useQuery({ queryKey: computed(() => ['agent-provider-model-options', props.serverId, modelSearch.value]), queryFn: () => api<{ models: import('~~/shared/agent-providers').AgentModelOption[]; defaultModel: string | null; deploymentProvider?: string | null }>(`/api/servers/${props.serverId}/agent-providers/model-options`, { query: { search: modelSearch.value } }) })
const connecting = useQuery({ queryKey: computed(() => ['agent-provider-connecting', props.serverId, editing.value?.id]), queryFn: () => api<{ provider: AgentProviderDTO }>(`/api/servers/${props.serverId}/agent-providers/${editing.value!.id}`), enabled: computed(() => Boolean(connection.value && editing.value)), refetchInterval: 2000 })
const providerCards: Record<AgentProviderId, { description: string }> = {
  openrouter: { description: 'Hundreds of models with one API key' },
  anthropic: { description: 'Claude models with an Anthropic API key' },
  chatgpt: { description: 'Your ChatGPT plan, for your own requests' },
}
// The deployment's own provider (Workers AI or an operator endpoint) is listed like the others.
type DeploymentState = { available: boolean; name: string | null; enabled: boolean; models: { id: string; label: string; selected: boolean }[]; deploymentModel: string | null }
const deployment = useQuery({ queryKey: computed(() => ['agent-deployment-provider', props.serverId]), queryFn: () => api<DeploymentState>(`/api/servers/${props.serverId}/agent-providers/deployment`), enabled: computed(() => props.isOwner) })
const deploymentOpen = ref(false)
const deploymentDraft = reactive({ enabled: true, selected: [] as string[] })
function editDeployment() {
  const value = deployment.data.value
  if (!value) return
  deploymentDraft.enabled = value.enabled
  deploymentDraft.selected = value.models.filter(model => model.selected).map(model => model.id)
  deploymentOpen.value = true
}
async function saveDeployment() {
  if (busy.value || !deployment.data.value) return
  busy.value = true
  try {
    const all = deployment.data.value.models.length
    await api(`/api/servers/${props.serverId}/agent-providers/deployment`, { method: 'PUT', body: { enabled: deploymentDraft.enabled, models: all && deploymentDraft.selected.length < all ? deploymentDraft.selected : null } })
    deploymentOpen.value = false
    await Promise.all([deployment.refetch(), refresh()])
  } catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { busy.value = false }
}
// Members connect only their own ChatGPT plan; Server API keys stay with the Owner.
const kinds = computed(() => agentProviderIds.filter(value => props.isOwner || value === 'chatgpt').map(value => ({ value, label: providerNames[value], ...providerCards[value] })))
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
  const kind = provider?.kind ?? (props.isOwner ? 'openrouter' : 'chatgpt')
  Object.assign(state, { kind, name: provider?.name ?? providerNames[kind], enabled: provider?.enabled ?? true, apiKey: '', webSearch: provider?.webSearch ?? false, shared: provider?.shared ?? false, models: provider?.models.map(m => ({ ...m })) ?? [] })
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
  const result = await api<{ provider: AgentProviderDTO }>(`/api/servers/${props.serverId}/agent-providers/${id}`, { method: 'PUT', body: { ...state, name: state.name.trim() || providerNames[state.kind], apiKey: state.apiKey || undefined, shared: state.kind === 'chatgpt' && editing.value?.mine ? state.shared : undefined } })
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
  // Opened during the click so the browser allows it; OpenAI's page loads once the attempt exists.
  const popup = window.open('about:blank', '_blank')
  busy.value = true
  try {
    const id = await persist()
    const result = await api<{ state: string; authorizationUrl: string; expiresAt: number }>(`/api/servers/${props.serverId}/agent-providers/${id}/connect`, { method: 'POST', body: { local: local.value } })
    connection.value = result
    if (popup) popup.location.href = result.authorizationUrl
  } catch (error) { popup?.close(); toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { busy.value = false }
}
// OpenAI returns ChatGPT sign-in only to 127.0.0.1. On a hosted Server nothing listens there, so the
// browser shows a connection error whose address holds the one-time code; pasting it finishes here.
const callbackUrl = ref(''), finishing = ref(false)
const callbackValid = computed(() => { try { const url = new URL(callbackUrl.value.trim()); return url.origin === 'http://127.0.0.1:1455' && url.pathname === '/auth/callback' && url.searchParams.has('state') } catch { return false } })
async function finishChatGPT() {
  if (!callbackValid.value || finishing.value) return
  finishing.value = true
  try { await api('/api/agent-auth/complete', { method: 'POST', body: { callbackUrl: callbackUrl.value.trim() } }); callbackUrl.value = ''; await connecting.refetch() }
  // A sign-in address works once; after a failure the next try needs a fresh one.
  catch (error) { callbackUrl.value = ''; connection.value = null; toast.add({ title: 'ChatGPT was not connected', description: errorMessage(error), color: 'error' }) }
  finally { finishing.value = false }
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
watch(open, value => { if (!value) { state.apiKey = ''; connection.value = null; callbackUrl.value = '' } })
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
    <button v-if="deployment.data.value?.available" type="button" class="flex w-full items-center gap-3 rounded-lg border border-default px-3 py-3 text-start hover:bg-elevated/50" @click="editDeployment">
      <span class="flex size-8 shrink-0 items-center justify-center rounded-md bg-elevated text-highlighted"><AgentsProviderLogo v-if="deployment.data.value.name === 'Workers AI'" kind="workers-ai" class="size-4" /><UIcon v-else name="i-ph-plugs-connected" class="size-4" /></span>
      <span class="min-w-0 flex-1"><span class="block truncate text-sm font-medium">{{ deployment.data.value.name }}</span><span class="block truncate text-xs text-muted">Included with this Server · {{ deployment.data.value.enabled ? (deployment.data.value.models.length ? `${deployment.data.value.models.filter(model => model.selected).length} models` : 'Enabled') : 'Disabled' }}</span></span>
      <UIcon name="i-ph-caret-right" class="size-4 text-dimmed" />
    </button>
    <UInput v-model="query" icon="i-ph-magnifying-glass" placeholder="Search providers" aria-label="Search providers" class="w-full" />
    <LayoutLoadError v-if="catalog.error.value" inline message="Providers did not load." :retry="catalog.refetch" />
    <LayoutEmptyState v-else-if="!catalog.isPending.value && !visible.length" icon="i-ph-plugs" :title="isOwner ? 'No model providers yet' : 'No ChatGPT connection yet'" :description="isOwner ? 'Add OpenRouter, an Anthropic API key or ChatGPT so agents can reply.' : 'Connect your ChatGPT plan to use it with agents. You decide whether to share it with everyone here.'" />
    <SettingsList v-else :items="visible" :item-key="provider => provider.id" :search-text="provider => provider.name" :search-from="Infinity" :noun="['provider', 'providers']" @select="edit"><template #row="{ item: provider }"><span class="flex size-8 shrink-0 items-center justify-center rounded-md bg-elevated text-highlighted"><AgentsProviderLogo :kind="provider.kind" class="size-4" /></span><span class="min-w-0 flex-1"><span class="block truncate text-sm font-medium">{{ provider.name }}</span><span class="block truncate text-xs text-muted">{{ providerNames[provider.kind] }} · {{ provider.account || provider.keyPreview || (provider.configured ? 'Connected' : 'Not connected') }} · {{ provider.enabled ? `${provider.models.length} models` : 'Disabled' }}{{ provider.personal ? provider.shared ? ' · Shared with everyone' : ' · Only you can use it' : '' }}</span></span></template></SettingsList>
    <UPagination v-if="(catalog.data.value?.total ?? 0) > 15" v-model:page="page" :items-per-page="15" :total="catalog.data.value?.total ?? 0" />
    </template>
  </section>
  <SettingsEditor v-model:open="deploymentOpen" back="Models" :title="deployment.data.value?.name ?? 'Deployment'" description="Comes with this Server's deployment, billed to its Cloudflare account. It cannot be removed here; turn it off or choose which models agents see.">
    <template #body>
      <div class="space-y-4">
        <UFormField label="Available to agents"><USwitch v-model="deploymentDraft.enabled" /></UFormField>
        <UFormField v-if="deployment.data.value?.models.length" label="Models" description="Models listed here appear in model pickers.">
          <ul class="divide-y divide-default rounded-md border border-default">
            <li v-for="model in deployment.data.value.models" :key="model.id" class="px-3 py-2"><UCheckbox v-model="deploymentDraft.selected" :value="model.id" :label="model.label" :description="model.id" :disabled="!deploymentDraft.enabled" /></li>
          </ul>
        </UFormField>
        <p v-else class="text-sm text-muted">Model: {{ deployment.data.value?.deploymentModel }}</p>
      </div>
    </template>
    <template #footer><UButton label="Cancel" color="neutral" variant="ghost" @click="deploymentOpen = false" /><UButton label="Save" :loading="busy" :disabled="deploymentDraft.enabled && Boolean(deployment.data.value?.models.length) && !deploymentDraft.selected.length" @click="saveDeployment" /></template>
  </SettingsEditor>
  <SettingsEditor v-model:open="open" back="Models" :title="editing ? `Configure ${editing.name}` : 'Add provider'" description="Connect an account and choose models for Agents and AI functions.">
    <template #body>
      <UForm id="agent-provider-form" :schema="agentProviderSchema.omit({ apiKey: true })" :state="state" class="space-y-4" @submit="save">
        <UFormField name="kind" label="Provider">
          <div v-if="!editing" class="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Provider">
            <button v-for="kind in kinds" :key="kind.value" type="button" role="radio" :aria-checked="state.kind === kind.value" class="flex flex-col items-start gap-1.5 rounded-md border p-3 text-start transition-colors" :class="state.kind === kind.value ? 'border-primary bg-elevated' : 'border-default hover:bg-elevated/50'" @click="state.kind = kind.value">
              <AgentsProviderLogo :kind="kind.value" class="size-6 text-highlighted" />
              <span class="text-sm font-medium text-highlighted">{{ kind.label }}</span>
              <span class="text-xs text-muted">{{ kind.description }}</span>
            </button>
          </div>
          <div v-else class="flex items-center gap-2 text-sm"><AgentsProviderLogo :kind="state.kind" class="size-5" /><span>{{ providerNames[state.kind] }}</span></div>
        </UFormField>
        <UFormField name="name" label="Connection name" description="Distinguish work, personal, or other accounts. Left empty, it uses the provider name."><UInput v-model="state.name" class="w-full" /></UFormField>
        <template v-if="state.kind === 'chatgpt'">
          <p class="text-sm text-muted">{{ editing?.account ? `Connected as ${editing.account}.` : 'Use your ChatGPT plan with Pi.' }} {{ state.shared ? 'Shared with everyone on this Server.' : 'Only you can use it unless you share it below.' }}</p>
          <UButton label="Continue with ChatGPT" color="neutral" variant="outline" :loading="busy" @click="connectChatGPT" />
          <template v-if="connection">
            <div v-if="local" class="space-y-2"><p class="text-sm text-muted">Finish signing in in the new tab. This page will update automatically.</p><UButton :to="connection.authorizationUrl" target="_blank" label="Open ChatGPT sign-in" color="neutral" variant="link" /></div>
            <div v-else class="space-y-3 rounded-md border border-default p-3">
              <p class="text-sm font-medium text-highlighted">One more step after you approve</p>
              <p class="text-sm text-muted">ChatGPT then opens a page that cannot load, at an address starting with <code class="text-xs">http://127.0.0.1:1455</code>. That is expected: OpenAI sends the sign-in back to your computer, not to a website. Copy that page’s full address and paste it here.</p>
              <UInput v-model="callbackUrl" placeholder="http://127.0.0.1:1455/auth/callback?code=…" class="w-full" autocomplete="off" aria-label="Address of the page ChatGPT opened" @keydown.enter.prevent="finishChatGPT" />
              <div class="flex flex-wrap items-center gap-2">
                <UButton label="Finish connecting" :disabled="!callbackValid" :loading="finishing" @click="finishChatGPT" />
                <UButton :to="connection.authorizationUrl" target="_blank" label="Open ChatGPT again" color="neutral" variant="link" />
              </div>
              <p class="text-xs text-muted">The address works once and expires in 10 minutes.</p>
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
        <UFormField v-if="state.kind === 'chatgpt' && editing?.configured && editing.mine" name="shared" label="Share with everyone on this Server" description="Members' agents and AI functions can then use this ChatGPT plan; their requests count against your plan's limits. Only you can change this."><USwitch v-model="state.shared" /></UFormField>
        <UFormField v-if="state.kind === 'openrouter'" name="webSearch" label="Web search" description="Allow agents with Browse Web permission to search. Additional OpenRouter charges apply."><USwitch v-model="state.webSearch" /></UFormField>
      </UForm>
    </template>
    <template #footer><UButton v-if="editing" label="Remove connection" color="error" variant="ghost" :disabled="busy" class="me-auto" @click="remove" /><UButton label="Cancel" color="neutral" variant="ghost" @click="open = false" /><UButton type="submit" form="agent-provider-form" label="Save" :disabled="!state.models.length && state.kind !== 'chatgpt'" :loading="busy" /></template>
  </SettingsEditor>
</template>
