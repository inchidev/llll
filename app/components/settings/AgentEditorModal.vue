<script setup lang="ts">
import SettingsEditor from './SettingsEditor.vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { FormSubmitEvent } from '@nuxt/ui'
import { z } from 'zod'
import { agentModelLabel, type AgentProviderCatalog } from '~~/shared/agent-providers'
import { Permission, PermissionGrants, MemberPermissions } from '~~/shared/permissions'
import { pausedPermissionKeys } from '~~/shared/features'
import { agentRoleSummary } from '~~/shared/agent-roles'
import { agentTemplates } from '~~/shared/agent-templates'
import type { AgentDTO, RoleDTO } from '~~/shared/types'
import { publicWebhookUrl, type AgentWebhookDTO } from '~~/shared/agent-webhooks'

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
const { can } = useRoleGrants()
const roleId = ref('member')
const roles = useQuery({ queryKey: computed(() => ['roles', props.serverId]), queryFn: () => api<{ roles: RoleDTO[] }>(`/api/servers/${props.serverId}/roles`), enabled: computed(() => open.value && can(Permission.manageRoles)) })
const selectedRole = computed(() => roles.data.value?.roles.find(role => role.id === roleId.value || (roleId.value === 'member' && role.key === 'member')))
const selectedPermissions = computed(() => selectedRole.value?.permissions ?? (roleId.value === 'member' ? MemberPermissions : null))
const selectedSummary = computed(() => selectedPermissions.value === null ? '' : agentRoleSummary({ permissions: selectedPermissions.value }))
const selectedGrants = computed(() => PermissionGrants.filter(grant => !pausedPermissionKeys.has(grant.key) && selectedPermissions.value !== null && ((selectedPermissions.value & grant.flag) === grant.flag)).map(grant => grant.label).join(', '))
const memberRoleId = computed(() => roles.data.value?.roles.find(role => role.key === 'member')?.id ?? 'member')
const roleSelection = computed({
  get: () => roleId.value === 'member' ? memberRoleId.value : roleId.value,
  set: (value: string) => { roleId.value = value },
})
const roleItems = computed(() => [
  { value: memberRoleId.value, label: 'Member' },
  ...(roles.data.value?.roles ?? []).filter(role => !['owner', 'member'].includes(role.key)).map(role => ({ value: role.id, label: role.key === 'admin' ? 'Admin' : role.name, description: agentRoleSummary(role) })),
])
const saving = ref(false)
const deleting = ref(false)
const confirmDelete = ref(false)
const busy = computed(() => saving.value || deleting.value)
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

// An external Agent works on its own computer: Runs wake it through a webhook and it answers through MCP.
const external = ref(false)
const webhook = reactive({ url: '', headerName: 'Authorization', headerValue: '', replyTimeoutMinutes: 20 })
const savedWebhook = useQuery({
  queryKey: computed(() => ['agent-webhook', props.serverId, selectedAgent.value?.id]),
  queryFn: () => api<{ webhook: AgentWebhookDTO | null }>(`/api/servers/${props.serverId}/agents/${selectedAgent.value!.id}/webhook`),
  enabled: computed(() => open.value && Boolean(selectedAgent.value)),
})
watch(() => savedWebhook.data.value, (data) => {
  if (!data) return
  external.value = Boolean(data.webhook)
  Object.assign(webhook, { url: data.webhook?.url ?? '', headerName: data.webhook?.headerName ?? 'Authorization', headerValue: '', replyTimeoutMinutes: data.webhook?.replyTimeoutMinutes ?? 20 })
}, { immediate: true })
const webhookError = computed(() => !external.value ? '' : !publicWebhookUrl(webhook.url.trim()) ? 'Use a public https:// URL' : '')
const mcpUrl = computed(() => import.meta.client ? `${window.location.origin}/mcp` : '/mcp')
const formAvatarUser = computed(() => ({
  id: selectedAgent.value?.id ?? `new-${form.displayName}`,
  kind: 'agent' as const,
  displayName: form.displayName || 'Agent',
  avatarR2Key: removeCurrentAvatar.value ? null : selectedAgent.value?.avatarR2Key ?? null,
}))

function selectAgent(agent: AgentDTO) {
  if (selectedAgent.value?.id !== agent.id) external.value = false
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
  external.value = false
  Object.assign(webhook, { url: '', headerName: 'Authorization', headerValue: '', replyTimeoutMinutes: 20 })
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

/** Deleting keeps messages, Runs and audit history; it stops all new work as this Agent. */
async function deleteAgent() {
  const agent = selectedAgent.value
  if (!agent || deleting.value) return
  deleting.value = true
  try {
    const result = await api<{ cancelledRuns: number; unassignedTasks: number }>(`/api/servers/${props.serverId}/agents/${agent.id}`, { method: 'DELETE' })
    confirmDelete.value = false
    open.value = false
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['agents', props.serverId] }),
      qc.invalidateQueries({ queryKey: ['members', props.serverId] }),
      qc.invalidateQueries({ queryKey: ['boards', props.serverId] }),
    ])
    const stopped = [result.cancelledRuns ? `${result.cancelledRuns} run${result.cancelledRuns === 1 ? '' : 's'} stopped` : '', result.unassignedTasks ? `${result.unassignedTasks} task${result.unassignedTasks === 1 ? '' : 's'} unassigned` : ''].filter(Boolean).join(', ')
    toast.add({ title: `${agent.displayName} deleted`, description: stopped || undefined, color: 'success' })
  }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { deleting.value = false }
}

async function saveAgent(event: FormSubmitEvent<AgentForm>) {
  if (busy.value) return
  if (webhookError.value) {
    toast.add({ title: webhookError.value, color: 'error' })
    return
  }
  if (isNew.value && !external.value && (providers.isPending.value || modelRequired.value)) {
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
    if (external.value) {
      await api(`/api/servers/${props.serverId}/agents/${result.agent.id}/webhook`, { method: 'PUT', body: {
        url: webhook.url.trim(), headerName: webhook.headerName.trim() || 'Authorization', replyTimeoutMinutes: webhook.replyTimeoutMinutes,
        ...(webhook.headerValue.trim() ? { headerValue: webhook.headerValue.trim() } : {}),
      } })
      webhook.headerValue = ''
    }
    else if (savedWebhook.data.value?.webhook) {
      await api(`/api/servers/${props.serverId}/agents/${result.agent.id}/webhook`, { method: 'DELETE' })
    }
    if (!creating) await qc.invalidateQueries({ queryKey: ['agent-webhook', props.serverId, result.agent.id] })

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
        title: creating ? 'Agent created, but its webhook or avatar could not be saved' : 'Agent updated, but its webhook or avatar could not be saved',
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
  <SettingsEditor v-model:open="open" back="Agents" :title="isNew ? 'Create agent' : `Edit ${selectedAgent?.displayName || 'agent'}`" :dismissible="!busy" :close="!busy" :ui="{ content: 'max-w-xl' }">
    <template #body>
    <UForm :schema="schema" :state="form" :disabled="busy" class="min-w-0 space-y-5" :data-update-blocked="busy" @submit="saveAgent">
      <UAlert
        v-if="agentsUnavailable && !external"
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
              :disabled="(session.health?.bindings?.r2 === false && !session.health?.bindings?.kv)"
            />
            <UButton
              v-if="selectedAgent?.avatarR2Key && !avatarFile && !removeCurrentAvatar"
              label="Remove"
              color="neutral"
              variant="ghost"
              size="sm"
              @click="removeCurrentAvatar = true"
            />
            <AgentsAvatarGenerate :server-id="serverId" :name="form.displayName" @use="file => { avatarFile = file; removeCurrentAvatar = false }" />
          </div>
        </div>
      </UFormField>

      <UFormField name="displayName" label="Name">
        <UInput v-model="form.displayName" autofocus class="w-full" />
      </UFormField>

      <UFormField label="Works on" description="An external agent, such as Grok Bot, runs on its own computer. Mentions wake it through its webhook and it answers through this Server's MCP.">
        <USwitch v-model="external" label="Its own computer (external agent)" />
      </UFormField>

      <template v-if="external">
        <UFormField label="Webhook URL" :error="webhook.url && webhookError ? webhookError : undefined" description="Each direct mention or DM sends one POST with the message, conversation and Run ID. Only direct mentions wake it.">
          <UInput v-model="webhook.url" type="url" placeholder="https://" class="w-full" />
        </UFormField>
        <div class="grid gap-3 sm:grid-cols-2">
          <UFormField label="Key header" description="As the webhook's sender expects it.">
            <UInput v-model="webhook.headerName" placeholder="Authorization" class="w-full" />
          </UFormField>
          <UFormField label="Sender key" :description="savedWebhook.data.value?.webhook?.hasHeaderValue ? 'Saved. Leave empty to keep it.' : 'Sent exactly as entered, for example Bearer …'">
            <UInput v-model="webhook.headerValue" type="password" autocomplete="off" :placeholder="savedWebhook.data.value?.webhook?.hasHeaderValue ? '••••••••' : ''" class="w-full" />
          </UFormField>
        </div>
        <UFormField label="Reply timeout" description="Minutes to wait for its reply in the thread before the Run fails.">
          <UInputNumber v-model="webhook.replyTimeoutMinutes" :min="2" :max="120" class="w-40" />
        </UFormField>
        <UAlert color="neutral" variant="subtle" title="Connect it back to this Server" :description="`In Settings → MCP, create an access token that acts as this agent and add ${mcpUrl} to the agent with that token. It answers with send_message in the Run's thread and keeps the permissions of its Role.`" />
      </template>

      <UFormField v-else name="model" :label="providers.data.value?.defaultModel ? 'Model (optional)' : 'Model'" description="Choose a model, or leave empty to use an available Server default. The conversation can override this model.">
        <USelectMenu v-model:search-term="modelSearch" v-model="form.model" :loading="providers.isFetching.value" :disabled="providers.isPending.value" ignore-filter value-key="value" :items="modelItems" :placeholder="providers.data.value?.defaultModel ? 'Server default' : 'Choose a model'" class="w-full" />
        <LayoutLoadError v-if="providers.error.value" message="Model choices did not load." :retry="providers.refetch" inline />
      </UFormField>

      <UFormField v-if="can(Permission.manageRoles)" label="Role" description="The role limits this agent's work. Channel and resource access still apply.">
        <USelect v-model="roleSelection" aria-label="Agent role" :loading="roles.isPending.value" :disabled="roles.isPending.value || roles.isError.value || busy" :items="roleItems" placeholder="Choose a role" class="w-full" />
        <LayoutLoadError v-if="roles.error.value" message="Roles did not load." :retry="roles.refetch" inline />
        <p v-if="selectedSummary" class="mt-2 text-sm text-muted">{{ selectedSummary }}</p>
        <p v-if="selectedGrants" class="mt-1 text-xs text-muted">Permissions: {{ selectedGrants }}.</p>
        <p class="mt-2 text-xs text-muted">Grant project work through a policy in Projects → Access. One agent can be Developer in one project and Reviewer in another. Templates do not change permissions.</p>
      </UFormField>
      <p v-else-if="isNew" class="text-sm text-muted">New agents start with the Member role. Ask someone with Manage roles to grant task execution and reporting permissions.</p>
      <UFormField label="Fill instructions from an example" help="Replaces the instructions below with example text. It grants no access; what the agent may do comes from policies in Projects → Access."><div class="flex flex-wrap gap-2"><UButton v-for="template in agentTemplates" :key="template.id" :label="template.name" color="neutral" variant="outline" :title="`Recommended project policy: ${template.policy}`" @click="form.instructions = template.instructions" /></div></UFormField>
      <UFormField name="instructions" label="Profile instructions">
        <UTextarea v-model="form.instructions" :rows="10" autoresize :maxrows="18" class="w-full" />
      </UFormField>

      <UFormField v-if="selectedAgent" name="status" label="Status">
        <USelect v-model="form.status" :items="statusOptions" class="w-full" />
      </UFormField>



      <div class="flex justify-end gap-2"><UButton v-if="selectedAgent && can(Permission.manageAgents)" label="Delete agent" color="error" variant="ghost" icon="i-ph-trash" class="me-auto" :disabled="busy" @click="confirmDelete = true" /><UButton label="Cancel" color="neutral" variant="ghost" :disabled="busy" @click="open = false" />
      <UButton type="submit" :label="isNew ? 'Create agent' : 'Save changes'" :loading="saving" :disabled="isNew && !external && (providers.isPending.value || modelRequired)" />
      </div>
    </UForm>
    </template>
  </SettingsEditor>
  <UModal v-model:open="confirmDelete" :title="`Delete ${selectedAgent?.displayName || 'agent'}?`" :dismissible="!deleting">
    <template #body>
      <div class="space-y-2 text-sm text-muted">
        <p>The agent leaves this Server and stops all work: queued and running Runs are cancelled, its Schedules stop and its MCP connections are revoked. Open Tasks assigned to it become unassigned.</p>
        <p>Its messages, Direct Messages, Run history and audit entries stay. This cannot be undone.</p>
      </div>
    </template>
    <template #footer>
      <UButton label="Cancel" color="neutral" variant="ghost" :disabled="deleting" @click="confirmDelete = false" />
      <UButton label="Delete agent" color="error" :loading="deleting" @click="deleteAgent" />
    </template>
  </UModal>
</template>
