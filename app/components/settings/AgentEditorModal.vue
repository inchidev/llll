<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { FormSubmitEvent } from '@nuxt/ui'
import { z } from 'zod'
import { agentModelLabel, type AgentProviderCatalog } from '~~/shared/agent-providers'
import type { AgentDTO } from '~~/shared/types'

const props = defineProps<{ serverId: string; agent?: AgentDTO | null }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ saved: [agent: AgentDTO] }>()
const toast = useToast()
const qc = useQueryClient()
const { api } = useApi()
const session = useSessionStore()
function defaultModel() {
  // The Server resolves an empty model to its default provider profile.
  return ''
}
const saving = ref(false)
const avatarFile = shallowRef<File | null>(null)
const removeCurrentAvatar = ref(false)

const statusOptions = [
  { label: 'Active', value: 'active' },
  { label: 'Paused', value: 'paused' },
]

const schema = z.object({
  displayName: z.string().trim().min(1, 'Enter a name').max(80),
  model: z.string().trim().max(200),
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

const modelSearch = ref('')
const providers = useQuery({ queryKey: computed(() => ['agent-provider-model-options', props.serverId, modelSearch.value, form.model]), queryFn: () => api<AgentProviderCatalog>(`/api/servers/${props.serverId}/agent-providers/model-options`, { query: { search: modelSearch.value, selected: form.model } }), enabled: open })
const savedModels = computed(() => providers.data.value?.models ?? [])
const agentsUnavailable = computed(() => session.health?.aiProvider === null && !providers.data.value?.defaultModel)

const selectedAgent = shallowRef<AgentDTO | null>(null)
const isNew = computed(() => !selectedAgent.value)
const formAvatarUser = computed(() => ({
  id: selectedAgent.value?.id ?? `new-${form.displayName}`,
  kind: 'agent' as const,
  displayName: form.displayName || 'Agent',
  avatarR2Key: removeCurrentAvatar.value ? null : selectedAgent.value?.avatarR2Key ?? null,
}))

function selectAgent(agent: AgentDTO) {
  selectedAgent.value = agent
  avatarFile.value = null
  removeCurrentAvatar.value = false
  Object.assign(form, {
    displayName: agent.displayName,
    model: agent.model,
    instructions: agent.instructions,
    status: agent.status,
  })
}

function createAgent() {
  selectedAgent.value = null
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
              :disabled="(session.health?.bindings.r2 === false && !session.health?.bindings.kv)"
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

      <UFormField name="model" label="Model (optional)" description="Empty uses the Server default. The conversation can override this model.">
        <USelectMenu v-model:search-term="modelSearch" v-model="form.model" ignore-filter value-key="value" virtualize :items="[{ value: '', label: 'Server default' }, ...savedModels.map(model => ({ value: model.value, label: agentModelLabel(model) })), ...(form.model && !savedModels.some(model => model.value === form.model) ? [{ value: form.model, label: form.model + ' (unavailable)' }] : [])]" placeholder="Server default" class="w-full" />
        <LayoutLoadError v-if="providers.error.value" message="Model choices did not load." :retry="providers.refetch" inline />
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
