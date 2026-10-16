<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { FormSubmitEvent } from '@nuxt/ui'
import { z } from 'zod'
import type { AgentDTO } from '~~/shared/types'

const props = defineProps<{ workspaceId: string }>()
const toast = useToast()
const qc = useQueryClient()
const { api } = useApi()
const session = useSessionStore()
const openAiCompatible = computed(() => session.health?.aiProvider === 'openai-compatible')
const workersAiRest = computed(() => session.health?.aiProvider === 'workers-ai-rest')
const workersAi = computed(() => session.health?.aiProvider === 'workers-ai' || workersAiRest.value)
const agentsUnavailable = computed(() => session.health?.aiProvider === null)
const browserCopy = computed(() => {
  const provider = session.health?.capabilities.browser
  if (provider === 'workers') return 'Cloudflare Browser Run reads public URLs. This is not a search engine.'
  if (provider === 'cloudflare-rest') return 'Cloudflare Browser Run reads public URLs through its REST API. This is not a search engine.'
  if (provider === 'cdp') return 'An external Chromium browser reads public URLs. This is not a search engine.'
  return 'Public page reading is unavailable. Bind Cloudflare Browser Run, set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, or set BROWSER_CDP_URL to a Chromium DevTools endpoint.'
})
function defaultModel() {
  if (session.health?.aiProvider === 'openai-compatible' && session.health.aiModel) return session.health.aiModel
  return '@cf/moonshotai/kimi-k2.7-code'
}
const selectedAgentId = shallowRef<string | null>(null)
const creatingNew = ref(false)
const saving = ref(false)
const avatarFile = shallowRef<File | null>(null)
const removeCurrentAvatar = ref(false)

const agentsQ = useQuery({
  queryKey: computed(() => ['agents', props.workspaceId]),
  queryFn: () => api<{ agents: AgentDTO[] }>(`/api/workspaces/${props.workspaceId}/agents`),
})
const agents = computed(() => agentsQ.data.value?.agents ?? [])

const modelOptions = [
  { id: '@cf/moonshotai/kimi-k2.7-code', label: 'Kimi K2.7 Code', description: 'Moonshot AI · Coding · reasoning · vision', avatar: { src: '/providers/moonshotai.svg', alt: 'Moonshot AI' } },
  { id: '@cf/zai-org/glm-5.3', label: 'GLM 5.3', description: 'Z.ai · Agentic coding · reasoning', avatar: { src: '/providers/zai.svg', alt: 'Z.ai' } },
  { id: '@cf/zai-org/glm-5.3-flash', label: 'GLM 5.3 Flash', description: 'Z.ai · Fast · reasoning · vision', avatar: { src: '/providers/zai.svg', alt: 'Z.ai' } },
  { id: '@cf/deepseek-ai/deepseek-v4-flash-0731', label: 'DeepSeek V4 Flash', description: 'DeepSeek · Fast · reasoning', avatar: { src: '/providers/deepseek.svg', alt: 'DeepSeek' } },
  { id: '@cf/deepseek-ai/deepseek-v4-pro-0813', label: 'DeepSeek V4 Pro', description: 'DeepSeek · Long-horizon · reasoning', avatar: { src: '/providers/deepseek.svg', alt: 'DeepSeek' } },
  { id: '@cf/openai/gpt-oss-120b', label: 'GPT-OSS 120B', description: 'OpenAI · High reasoning · tools', avatar: { src: '/providers/openai.svg', alt: 'OpenAI' } },
  { id: '@cf/openai/gpt-oss-20b', label: 'GPT-OSS 20B', description: 'OpenAI · Fast · reasoning · tools', avatar: { src: '/providers/openai.svg', alt: 'OpenAI' } },
  { id: '@cf/qwen/qwen3.8-27b', label: 'Qwen 3.8 27B', description: 'Qwen · Reasoning · vision', avatar: { src: '/providers/qwen.svg', alt: 'Qwen' } },
  { id: '@cf/qwen/qwen3-30b-a3b-fp8', label: 'Qwen3 30B A3B', description: 'Qwen · Fast · reasoning', avatar: { src: '/providers/qwen.svg', alt: 'Qwen' } },
  { id: '@cf/google/gemma-4-26b-a4b-it', label: 'Gemma 4 26B A4B', description: 'Google · Reasoning · vision', avatar: { src: '/providers/google.svg', alt: 'Google' } },
  { id: '@cf/nvidia/nemotron-3-120b-a12b', label: 'Nemotron 3 120B A12B', description: 'NVIDIA · Multi-agent · reasoning', avatar: { src: '/providers/nvidia.svg', alt: 'NVIDIA' } },
  { id: '@cf/moonshotai/kimi-k2.6', label: 'Kimi K2.6', description: 'Moonshot AI · Reasoning · vision', avatar: { src: '/providers/moonshotai.svg', alt: 'Moonshot AI' } },
  { id: '@cf/zai-org/glm-5.2', label: 'GLM 5.2', description: 'Z.ai · Agentic coding · reasoning', avatar: { src: '/providers/zai.svg', alt: 'Z.ai' } },
  { id: '@cf/zai-org/glm-4.7-flash', label: 'GLM 4.7 Flash', description: 'Z.ai · Fast · multilingual · reasoning', avatar: { src: '/providers/zai.svg', alt: 'Z.ai' } },
  { id: '@cf/meta/llama-4-scout-17b-16e-instruct', label: 'Llama 4 Scout 17B', description: 'Meta · Vision · tools', avatar: { src: '/providers/meta.svg', alt: 'Meta' } },
  { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', label: 'Llama 3.3 70B Fast', description: 'Meta · General · fast · tools', avatar: { src: '/providers/meta.svg', alt: 'Meta' } },
  { id: '@cf/mistralai/mistral-small-3.1-24b-instruct', label: 'Mistral Small 3.1 24B', description: 'Mistral AI · General · tools', avatar: { src: '/providers/mistralai.svg', alt: 'Mistral AI' } },
  { id: '@cf/ibm-granite/granite-4.0-h-micro', label: 'Granite 4.0 H Micro', description: 'IBM · Efficient · tools', avatar: { src: '/providers/ibm.svg', alt: 'IBM' } },
]
const statusOptions = [
  { label: 'Active', value: 'active' },
  { label: 'Paused', value: 'paused' },
]

const schema = z.object({
  displayName: z.string().trim().min(1, 'Enter a name').max(80),
  model: z.string().trim().min(1, 'Choose a model').max(200),
  instructions: z.string().trim().max(12_000),
  status: z.enum(['active', 'paused']),
})
type AgentForm = z.output<typeof schema>

const form = reactive<AgentForm>({
  displayName: '',
  model: defaultModel(),
  instructions: '',
  status: 'active',
})

const selectedAgent = computed(() => agents.value.find(agent => agent.id === selectedAgentId.value) ?? null)
const isNew = computed(() => creatingNew.value || !selectedAgent.value)
const formAvatarUser = computed(() => ({
  id: selectedAgent.value?.id ?? `new-${form.displayName}`,
  kind: 'agent' as const,
  displayName: form.displayName || 'Agent',
  avatarR2Key: removeCurrentAvatar.value ? null : selectedAgent.value?.avatarR2Key ?? null,
}))

function agentAvatarUser(agent: AgentDTO) {
  return {
    id: agent.id,
    kind: 'agent' as const,
    displayName: agent.displayName,
    avatarR2Key: agent.avatarR2Key,
  }
}

function modelOption(value: unknown) {
  return modelOptions.find(option => option.id === value)
}

function modelLabel(model: string) {
  if (openAiCompatible.value && model.startsWith('@cf/')) return session.health?.aiModel || model
  if (!workersAi.value) return model
  return modelOption(model)?.label ?? model
}

function selectAgent(agent: AgentDTO) {
  creatingNew.value = false
  selectedAgentId.value = agent.id
  avatarFile.value = null
  removeCurrentAvatar.value = false
  Object.assign(form, {
    displayName: agent.displayName,
    model: openAiCompatible.value && agent.model.startsWith('@cf/')
      ? (session.health?.aiModel || agent.model)
      : agent.model,
    instructions: agent.instructions,
    status: agent.status,
  })
}

function createAgent() {
  creatingNew.value = true
  selectedAgentId.value = null
  avatarFile.value = null
  removeCurrentAvatar.value = false
  Object.assign(form, {
    displayName: '',
    model: defaultModel(),
    instructions: '',
    status: 'active',
  })
}

watch(() => [session.health?.aiProvider, session.health?.aiModel] as const, () => {
  const model = session.health?.aiModel
  if (!openAiCompatible.value || !model) return
  if (!form.model || form.model.startsWith('@cf/')) form.model = model
})

watch(agents, (list) => {
  if (!list.length) return
  if (creatingNew.value) return
  const selected = list.find(agent => agent.id === selectedAgentId.value) ?? list[0]
  if (selected) selectAgent(selected)
}, { immediate: true })

async function saveAgent(event: FormSubmitEvent<AgentForm>) {
  if (avatarFile.value && avatarFile.value.size > 2 * 1024 * 1024) {
    toast.add({ title: 'Avatar exceeds 2 MB', color: 'error' })
    return
  }
  const creating = isNew.value
  let persistedAgent: AgentDTO | null = null
  saving.value = true
  try {
    let result: { agent: AgentDTO }
    if (selectedAgent.value) {
      result = await api<{ agent: AgentDTO }>(`/api/workspaces/${props.workspaceId}/agents/${selectedAgent.value.id}`, {
        method: 'PATCH',
        body: event.data,
      })
    }
    else {
      result = await api<{ agent: AgentDTO }>(`/api/workspaces/${props.workspaceId}/agents`, {
        method: 'POST',
        body: {
          displayName: event.data.displayName,
          model: event.data.model,
          instructions: event.data.instructions,
        },
      })
      creatingNew.value = false
      selectedAgentId.value = result.agent.id
    }
    persistedAgent = result.agent

    if (avatarFile.value) {
      const formData = new FormData()
      formData.append('file', avatarFile.value)
      const avatar = await api<{ avatarR2Key: string }>(`/api/workspaces/${props.workspaceId}/agents/${result.agent.id}/avatar`, {
        method: 'PUT',
        body: formData,
      })
      result.agent.avatarR2Key = avatar.avatarR2Key
    }
    else if (removeCurrentAvatar.value && result.agent.avatarR2Key) {
      await api(`/api/workspaces/${props.workspaceId}/agents/${result.agent.id}/avatar`, { method: 'DELETE' })
      result.agent.avatarR2Key = null
    }
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['agents', props.workspaceId] }),
      qc.invalidateQueries({ queryKey: ['members', props.workspaceId] }),
    ])
    selectAgent(result.agent)
    toast.add({ title: creating ? 'Agent created' : 'Agent updated', color: 'success' })
  }
  catch (error) {
    if (persistedAgent) {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['agents', props.workspaceId] }),
        qc.invalidateQueries({ queryKey: ['members', props.workspaceId] }),
      ])
      selectAgent(persistedAgent)
      toast.add({
        title: creating ? 'Agent created, but avatar could not be saved' : 'Agent updated, but avatar could not be saved',
        description: errorMessage(error),
        color: 'error',
      })
    }
    else {
      toast.add({ title: errorMessage(error), color: 'error' })
    }
  }
  finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="flex items-center justify-between gap-3">
    <h1 class="text-xl font-semibold text-highlighted">Agents</h1>
    <UButton icon="i-ph-plus" label="Add agent" size="sm" @click="createAgent" />
  </div>

  <LayoutSkeleton v-if="agentsQ.isPending.value" variant="cards" class="mt-6" />
  <LayoutLoadError v-else-if="agentsQ.error.value" message="Agents did not load." :retry="agentsQ.refetch" />
  <div v-else class="mt-6 grid min-h-[520px] gap-6 lg:grid-cols-[210px_minmax(0,1fr)]">
    <div class="space-y-1">
      <button
        v-for="agent in agents"
        :key="agent.id"
        type="button"
        class="w-full rounded-md px-3 py-2 text-start hover:bg-elevated"
        :class="selectedAgentId === agent.id && !creatingNew ? 'bg-accented text-highlighted' : 'text-muted'"
        @click="selectAgent(agent)"
      >
        <span class="flex items-center gap-2">
          <UserAvatar :user="agentAvatarUser(agent)" size="sm" />
          <span class="min-w-0">
            <span class="block truncate text-sm font-medium">{{ agent.displayName }}</span>
            <span class="block truncate text-xs text-muted">{{ agent.status }} · {{ modelLabel(agent.model) }}</span>
          </span>
        </span>
      </button>
      <p v-if="!agents.length" class="px-3 py-2 text-sm text-muted">No agents</p>
    </div>

    <UForm :schema="schema" :state="form" class="min-w-0 max-w-2xl space-y-5" @submit="saveAgent">
      <UAlert
        v-if="agentsUnavailable"
        color="neutral"
        variant="subtle"
        title="Agents need a model provider"
        description="Bind Workers AI, or set AI_BASE_URL, AI_API_KEY, and AI_MODEL for an OpenAI-compatible endpoint."
      />
      <UFormField name="displayName" label="Name">
        <UInput v-model="form.displayName" class="w-full" />
      </UFormField>

      <UFormField label="Avatar">
        <div class="flex items-center gap-3">
          <UserAvatar :user="formAvatarUser" size="lg" />
          <UFileUpload
            v-model="avatarFile"
            accept="image/png,image/jpeg,image/webp,image/gif"
            variant="button"
            label="Choose image"
            :disabled="session.health?.bindings.r2 === false"
          />
          <UButton
            v-if="selectedAgent?.avatarR2Key && !avatarFile && !removeCurrentAvatar"
            label="Remove"
            color="neutral"
            variant="ghost"
            size="sm"
            @click="removeCurrentAvatar = true"
          />
        </div>
      </UFormField>

      <UFormField
        v-if="workersAi || openAiCompatible"
        name="model"
        label="Model"
        :description="openAiCompatible ? `Sent to the OpenAI-compatible endpoint. This installation's AI_MODEL is ${session.health?.aiModel}.` : workersAiRest ? 'Sent to Workers AI through the Cloudflare REST API.' : undefined"
      >
        <template v-if="workersAi" #hint>
          <ULink
            to="https://developers.cloudflare.com/workers-ai/models/"
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex items-center gap-1 hover:text-highlighted"
          >
            <span>Workers AI</span>
            <UIcon name="i-ph-arrow-square-out" class="size-3" />
          </ULink>
        </template>
        <UInput v-if="openAiCompatible" v-model="form.model" class="w-full" />
        <USelect
          v-else
          v-model="form.model"
          :items="modelOptions"
          :avatar="modelOption(form.model)?.avatar"
          value-key="id"
          label-key="label"
          class="w-full"
        />
      </UFormField>

      <UFormField name="instructions" label="Profile instructions">
        <UTextarea v-model="form.instructions" :rows="10" autoresize :maxrows="18" class="w-full" />
      </UFormField>

      <UFormField v-if="selectedAgent" name="status" label="Status">
        <USelect v-model="form.status" :items="statusOptions" class="w-full" />
      </UFormField>

      <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 border-t border-default pt-5 text-sm">
        <dt class="text-muted">Browser</dt>
        <dd :class="browserCopy.startsWith('Public page') ? 'text-muted' : ''">{{ browserCopy }}</dd>
        <dt class="text-muted">Containers</dt>
        <dd class="text-muted">Agents have no container, computer, or shell on this installation.</dd>
        <dt class="text-muted">Tasks</dt>
        <dd>Can read tasks and create new tasks.</dd>
        <template v-if="selectedAgent">
          <dt class="text-muted">Last active</dt>
          <dd>{{ selectedAgent.lastActiveAt ? new Date(selectedAgent.lastActiveAt).toLocaleString() : 'Never' }}</dd>
        </template>
      </dl>

      <UButton type="submit" :label="isNew ? 'Create agent' : 'Save changes'" :loading="saving" :disabled="agentsUnavailable" />
    </UForm>
  </div>
</template>
