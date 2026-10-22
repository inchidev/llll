<script setup lang="ts">
import { useQueryClient } from '@tanstack/vue-query'
import type { FormSubmitEvent } from '@nuxt/ui'
import { z } from 'zod'
import type { AgentDTO } from '~~/shared/types'

const props = defineProps<{ serverId: string; agent?: AgentDTO | null }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ saved: [agent: AgentDTO] }>()
const toast = useToast()
const qc = useQueryClient()
const { api } = useApi()
const session = useSessionStore()
const openAiCompatible = computed(() => session.health?.aiProvider === 'openai-compatible')
const workersAiRest = computed(() => session.health?.aiProvider === 'workers-ai-rest')
const workersAi = computed(() => session.health?.aiProvider === 'workers-ai' || workersAiRest.value)
const agentsUnavailable = computed(() => session.health?.aiProvider === null)
function defaultModel() {
  // The Server resolves an empty model to its default provider profile.
  return ''
}
const saving = ref(false)
const avatarFile = shallowRef<File | null>(null)
const removeCurrentAvatar = ref(false)

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
  harness: z.enum(['pi', 'think']),
  displayName: z.string().trim().min(1, 'Enter a name').max(80),
  model: z.string().trim().max(200),
  instructions: z.string().trim().max(12_000),
  status: z.enum(['active', 'paused']),
})
type AgentForm = z.output<typeof schema>

const form = reactive<AgentForm>({
  harness: session.health?.capabilities.containers ? 'pi' : 'think',
  displayName: '',
  model: defaultModel(),
  instructions: '',
  status: 'active',
})

const selectedAgent = shallowRef<AgentDTO | null>(null)
const isNew = computed(() => !selectedAgent.value)
const formAvatarUser = computed(() => ({
  id: selectedAgent.value?.id ?? `new-${form.displayName}`,
  kind: 'agent' as const,
  displayName: form.displayName || 'Agent',
  avatarR2Key: removeCurrentAvatar.value ? null : selectedAgent.value?.avatarR2Key ?? null,
}))

function modelOption(value: unknown) {
  return modelOptions.find(option => option.id === value)
}

function selectAgent(agent: AgentDTO) {
  selectedAgent.value = agent
  avatarFile.value = null
  removeCurrentAvatar.value = false
  Object.assign(form, {
    harness: agent.harness ?? 'think',
    displayName: agent.displayName,
    model: openAiCompatible.value && agent.model.startsWith('@cf/')
      ? (session.health?.aiModel || agent.model)
      : agent.model,
    instructions: agent.instructions,
    status: agent.status,
  })
}

function createAgent() {
  selectedAgent.value = null
  avatarFile.value = null
  removeCurrentAvatar.value = false
  Object.assign(form, {
    harness: session.health?.capabilities.containers ? 'pi' : 'think',
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

watch([open, () => props.agent], ([visible, agent]) => {
  if (!visible) return
  if (agent) selectAgent(agent)
  else createAgent()
}, { immediate: true })

async function saveAgent(event: FormSubmitEvent<AgentForm>) {
  if (saving.value) return
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
      result = await api<{ agent: AgentDTO }>(`/api/servers/${props.serverId}/agents/${selectedAgent.value.id}`, {
        method: 'PATCH',
        body: event.data,
      })
    }
    else {
      result = await api<{ agent: AgentDTO }>(`/api/servers/${props.serverId}/agents`, {
        method: 'POST',
        body: {
          harness: event.data.harness,
          displayName: event.data.displayName,
          model: event.data.model,
          instructions: event.data.instructions,
        },
      })
      selectedAgent.value = result.agent
    }
    persistedAgent = result.agent

    if (avatarFile.value) {
      const formData = new FormData()
      formData.append('file', avatarFile.value)
      const avatar = await api<{ avatarR2Key: string }>(`/api/servers/${props.serverId}/agents/${result.agent.id}/avatar`, {
        method: 'PUT',
        body: formData,
      })
      result.agent.avatarR2Key = avatar.avatarR2Key
    }
    else if (removeCurrentAvatar.value && result.agent.avatarR2Key) {
      await api(`/api/servers/${props.serverId}/agents/${result.agent.id}/avatar`, { method: 'DELETE' })
      result.agent.avatarR2Key = null
    }
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['agents', props.serverId] }),
      qc.invalidateQueries({ queryKey: ['members', props.serverId] }),
    ])
    selectAgent(result.agent)
    emit('saved', result.agent)
    open.value = false
    toast.add({ title: creating ? 'Agent created' : 'Agent updated', color: 'success' })
  }
  catch (error) {
    if (persistedAgent) {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['agents', props.serverId] }),
        qc.invalidateQueries({ queryKey: ['members', props.serverId] }),
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
  <UModal v-model:open="open" :title="isNew ? 'Create agent' : `Edit ${selectedAgent?.displayName || 'agent'}`" :dismissible="!saving" :close="!saving" :ui="{ content: 'max-w-xl' }">
    <template #body>
    <UForm :schema="schema" :state="form" class="min-w-0 space-y-5" :data-update-blocked="saving" @submit="saveAgent">
      <UAlert
        v-if="agentsUnavailable"
        color="neutral"
        variant="subtle"
        title="Agents need a model provider"
        description="Ask the Server operator to connect a model provider."
      />
      <UFormField label="Avatar">
        <div class="flex items-center gap-4">
          <UserAvatar :user="formAvatarUser" size="2xl" />
          <div class="space-y-2">
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
        </div>
      </UFormField>

      <UFormField name="displayName" label="Name">
        <UInput v-model="form.displayName" autofocus class="w-full" />
      </UFormField>

      <UFormField
        v-if="workersAi || openAiCompatible"
        name="model"
        label="Model (optional)"
        :description="openAiCompatible ? `Sent to the OpenAI-compatible endpoint. Empty uses this Server's AI_MODEL (${session.health?.aiModel}).` : workersAiRest ? 'Sent to Workers AI through the Cloudflare REST API. Empty uses the Server default.' : undefined"
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
        <UInput v-if="openAiCompatible" v-model="form.model" class="w-full" placeholder="Server default" />
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

      <UFormField name="harness" label="Agent runtime" description="Permissions come from the assigned Role. Changing the runtime starts a separate conversation context.">
        <USelect v-model="form.harness" :items="[{ label: 'Pi', value: 'pi', disabled: !session.health?.capabilities.containers }, { label: 'Think', value: 'think' }]" class="w-full" />
        <p v-if="!session.health?.capabilities.containers" class="mt-2 text-sm text-muted">Pi needs an execution provider configured by the Server operator.</p>
      </UFormField>

      <UFormField name="instructions" label="Profile instructions">
        <UTextarea v-model="form.instructions" :rows="10" autoresize :maxrows="18" class="w-full" />
      </UFormField>

      <UFormField v-if="selectedAgent" name="status" label="Status">
        <USelect v-model="form.status" :items="statusOptions" class="w-full" />
      </UFormField>



      <div class="flex justify-end gap-2"><UButton label="Cancel" color="neutral" variant="ghost" :disabled="saving" @click="open = false" />
      <UButton type="submit" :label="isNew ? 'Create agent' : 'Save changes'" :loading="saving" :disabled="isNew && agentsUnavailable" />
      </div>
    </UForm>
    </template>
  </UModal>
</template>
