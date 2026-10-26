<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { FormSubmitEvent } from '@nuxt/ui'
import { z } from 'zod'
import { agentModelLabel, type AgentProviderCatalog } from '~~/shared/agent-providers'
import { Permission, PermissionGrants, MemberPermissions } from '~~/shared/permissions'
import { agentRoleSummary, TaskAgentGrants, TaskAgentPermissions, FactoryAgentPermissions } from '~~/shared/agent-roles'
import { resourceAccessWithin } from '~~/shared/resource-access'
import type { AgentDTO, RoleDTO } from '~~/shared/types'

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
const { can, mine } = useRoleGrants()
const roleId = ref('member')
const roles = useQuery({ queryKey: computed(() => ['roles', props.serverId]), queryFn: () => api<{ roles: RoleDTO[] }>(`/api/servers/${props.serverId}/roles`), enabled: computed(() => open.value && can(Permission.manageRoles)) })
const creatingRole = ref(false)
const canUseFactoryRole = computed(() => can(Permission.manageRoles) && PermissionGrants.filter(grant => (FactoryAgentPermissions & grant.flag) === grant.flag).every(grant => can(grant.flag)))
const canUseTaskRole = computed(() => can(Permission.manageRoles) && TaskAgentGrants.every(grant => can(grant.flag)))
const selectedRole = computed(() => roles.data.value?.roles.find(role => role.id === roleId.value || (roleId.value === 'member' && role.key === 'member')))
const selectedPermissions = computed(() => selectedRole.value?.permissions ?? (roleId.value === 'member' ? MemberPermissions : null))
const selectedSummary = computed(() => selectedPermissions.value === null ? '' : agentRoleSummary({ permissions: selectedPermissions.value }))
const selectedGrants = computed(() => PermissionGrants.filter(grant => selectedPermissions.value !== null && ((selectedPermissions.value & grant.flag) === grant.flag)).map(grant => grant.label).join(', '))
const memberRoleId = computed(() => roles.data.value?.roles.find(role => role.key === 'member')?.id ?? 'member')
const roleSelection = computed({
  get: () => roleId.value === 'member' ? memberRoleId.value : roleId.value,
  set: (value: string) => { roleId.value = value },
})
const roleItems = computed(() => [
  { value: memberRoleId.value, label: 'Member' },
  ...(roles.data.value?.roles ?? []).filter(role => !['owner', 'member'].includes(role.key)).map(role => ({ value: role.id, label: role.key === 'admin' ? 'Admin' : role.name, description: agentRoleSummary(role) })),
])
async function useTaskRole(factory = false) {
  if (!(factory ? canUseFactoryRole.value : canUseTaskRole.value) || busy.value) return
  const permissions = factory ? FactoryAgentPermissions : TaskAgentPermissions, name = factory ? 'Factory agent' : 'Task agent'
  const existing = roles.data.value?.roles.find(role => role.name === name && role.permissions === permissions && resourceAccessWithin(role.resourceAccess ?? {}, mine?.value?.role.resourceAccess))
  if (existing) { roleId.value = existing.id; return }
  creatingRole.value = true
  try {
    const result = await api<{ role: RoleDTO }>(`/api/servers/${props.serverId}/roles`, {
      method: 'POST',
      body: { name, permissions, resourceAccess: mine?.value?.role.resourceAccess ?? {} },
    })
    await qc.invalidateQueries({ queryKey: ['roles', props.serverId] })
    roleId.value = result.role.id
  } catch (error) {
    toast.add({ title: errorMessage(error), color: 'error' })
  } finally { creatingRole.value = false }
}
const saving = ref(false)
const busy = computed(() => saving.value || creatingRole.value)
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
const modelRequired = computed(() => !form.model && !providers.data.value?.defaultModel)
const agentsUnavailable = computed(() => providers.isSuccess.value && !modelSearch.value && modelRequired.value && !savedModels.value.length)
const modelItems = computed(() => [
  ...(providers.data.value?.defaultModel ? [{ value: '', label: 'Server default' }] : []),
  ...savedModels.value.map(model => ({ value: model.value, label: agentModelLabel(model) })),
  ...(form.model && !providers.isFetching.value && !savedModels.value.some(model => model.value === form.model) ? [{ value: form.model, label: form.model + ' (unavailable)' }] : []),
])

const selectedAgent = shallowRef<AgentDTO | null>(null)
const isNew = computed(() => !selectedAgent.value)
const formAvatarUser = computed(() => ({
  id: selectedAgent.value?.id ?? `new-${form.displayName}`,
  kind: 'agent' as const,
  displayName: form.displayName || 'Agent',
  avatarR2Key: removeCurrentAvatar.value ? null : selectedAgent.value?.avatarR2Key ?? null,
}))

function selectAgent(agent: AgentDTO) {
  roleId.value = agent.roleId ?? ''
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
  roleId.value = 'member'
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

watch([open, () => props.agent], ([visible, agent]) => {
  if (!visible) return
  if (agent) selectAgent(agent)
  else createAgent()
}, { immediate: true })

async function saveAgent(event: FormSubmitEvent<AgentForm>) {
  if (busy.value) return
  if (isNew.value && (providers.isPending.value || modelRequired.value)) {
    toast.add({ title: 'Choose a model or set a Server default before creating an agent', color: 'error' })
    return
  }
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
        body: { ...event.data, ...(can(Permission.manageRoles) && roleId.value && roleId.value !== selectedAgent.value.roleId ? { roleId: roleId.value } : {}) },
      })
    }
    else {
      result = await api<{ agent: AgentDTO }>(`/api/servers/${props.serverId}/agents`, {
        method: 'POST',
        body: {
          roleId: roleId.value === 'member' ? undefined : roleId.value,
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
    open.value = false
    emit('saved', result.agent)
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['agents', props.serverId] }),
      qc.invalidateQueries({ queryKey: ['members', props.serverId] }),
      qc.invalidateQueries({ queryKey: ['roles', props.serverId] }),
    ])
    selectAgent(result.agent)
    toast.add({ title: creating ? 'Agent created' : 'Agent updated', color: 'success' })
  }
  catch (error) {
    if (persistedAgent) {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['agents', props.serverId] }),
        qc.invalidateQueries({ queryKey: ['members', props.serverId] }),
      qc.invalidateQueries({ queryKey: ['roles', props.serverId] }),
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
  <UModal v-model:open="open" :title="isNew ? 'Create agent' : `Edit ${selectedAgent?.displayName || 'agent'}`" :dismissible="!busy" :close="!busy" :ui="{ content: 'max-w-xl' }">
    <template #body>
    <UForm :schema="schema" :state="form" :disabled="busy" class="min-w-0 space-y-5" :data-update-blocked="busy" @submit="saveAgent">
      <UAlert
        v-if="agentsUnavailable"
        color="neutral"
        variant="subtle"
        title="Agents need a model provider"
        description="Choose a model below or set a Server default in Providers. Connecting a provider does not select a default."
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

      <UFormField name="model" :label="providers.data.value?.defaultModel ? 'Model (optional)' : 'Model'" description="Choose a model, or leave empty to use an available Server default. The conversation can override this model.">
        <USelectMenu v-model:search-term="modelSearch" v-model="form.model" :loading="providers.isFetching.value" :disabled="providers.isPending.value" ignore-filter value-key="value" :items="modelItems" :placeholder="providers.data.value?.defaultModel ? 'Server default' : 'Choose a model'" class="w-full" />
        <LayoutLoadError v-if="providers.error.value" message="Model choices did not load." :retry="providers.refetch" inline />
      </UFormField>

      <UFormField v-if="can(Permission.manageRoles)" label="Role" description="The role limits this agent's work. Channel and resource access still apply.">
        <USelect v-model="roleSelection" aria-label="Agent role" :loading="roles.isPending.value" :disabled="roles.isPending.value || roles.isError.value || busy" :items="roleItems" placeholder="Choose a role" class="w-full" />
        <LayoutLoadError v-if="roles.error.value" message="Roles did not load." :retry="roles.refetch" inline />
        <p v-if="selectedSummary" class="mt-2 text-sm text-muted">{{ selectedSummary }}</p>
        <p v-if="selectedGrants" class="mt-1 text-xs text-muted">Permissions: {{ selectedGrants }}.</p>
        <UButton v-if="canUseFactoryRole" class="mt-2" label="Use Factory agent role" color="neutral" variant="soft" :loading="creatingRole" :disabled="busy || roles.isPending.value || roles.isError.value" @click="useTaskRole(true)" />
        <p v-if="canUseFactoryRole" class="text-xs text-muted">Factory grants Read projects, Read tasks, Execute assigned tasks, Send messages, Use a computer and Propose code changes within your selected resource scopes. Each coding operation still needs human review.</p>
        <template v-if="canUseTaskRole">
          <UButton class="mt-2" label="Use task agent role" color="neutral" variant="soft" :loading="creatingRole" :disabled="busy || roles.isPending.value || roles.isError.value" @click="useTaskRole(false)" />
          <p class="mt-1 text-xs text-muted">Creates or selects a role with Read tasks, Create and update tasks, Execute assigned tasks and Send messages. New roles inherit your resource limits and grant no administration or computer tools. Save the agent to apply the selection.</p>
        </template>
      </UFormField>
      <p v-else-if="isNew" class="text-sm text-muted">New agents start with the Member role. Ask someone with Manage roles to grant task execution and reporting permissions.</p>
      <UFormField name="instructions" label="Profile instructions">
        <UTextarea v-model="form.instructions" :rows="10" autoresize :maxrows="18" class="w-full" />
      </UFormField>

      <UFormField v-if="selectedAgent" name="status" label="Status">
        <USelect v-model="form.status" :items="statusOptions" class="w-full" />
      </UFormField>



      <div class="flex justify-end gap-2"><UButton label="Cancel" color="neutral" variant="ghost" :disabled="busy" @click="open = false" />
      <UButton type="submit" :label="isNew ? 'Create agent' : 'Save changes'" :loading="saving" :disabled="creatingRole || (isNew && (providers.isPending.value || modelRequired))" />
      </div>
    </UForm>
    </template>
  </UModal>
</template>
