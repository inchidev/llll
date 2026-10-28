<script setup lang="ts">
import SettingsEditor from './SettingsEditor.vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { MemberDTO, RoleDTO } from '~~/shared/types'
import { Permission } from '~~/shared/permissions'
import type { ProjectPolicy } from '~~/shared/project-access'


const props = defineProps<{ serverId: string }>()
const emit = defineEmits<{ 'list-visible': [visible: boolean] }>()

const { api } = useApi()
const qc = useQueryClient()
const toast = useToast()

const rolesQ = useQuery({
  queryKey: computed(() => ['roles', props.serverId]),
  queryFn: () => api<{ roles: RoleDTO[] }>(`/api/servers/${props.serverId}/roles`),
  enabled: computed(() => Boolean(props.serverId)),
})
const membersQ = useQuery({
  queryKey: computed(() => ['members', props.serverId]),
  queryFn: () => api<{ members: MemberDTO[] }>(`/api/servers/${props.serverId}/members`),
  enabled: computed(() => Boolean(props.serverId)),
})
const { can, mine } = usePermissions(computed(() => membersQ.data.value?.members))
const canManage = computed(() => can(Permission.manageRoles))
const isOwner = computed(() => mine.value?.role.key === 'owner')

const roles = computed(() => [...(rolesQ.data.value?.roles ?? [])].sort((a, b) => a.position - b.position))
const members = computed(() => membersQ.data.value?.members ?? [])

type Tab = 'display' | 'permissions' | 'members'
const selectedRoleId = ref<string | null>(null)
const tab = ref<Tab>('permissions')
const selectedRole = computed(() => roles.value.find(role => role.id === selectedRoleId.value) ?? null)
watch(selectedRole, role => emit('list-visible', !role), { immediate: true })
const readOnly = computed(() => !selectedRole.value || selectedRole.value.isSystem || !canManage.value)
// The Owner can add policies to Admin and Member; their name and built-in policy stay fixed.
const policiesReadOnly = computed(() => !selectedRole.value || !canManage.value || (selectedRole.value.isSystem && (selectedRole.value.key === 'owner' || !isOwner.value)))
const lockedPolicy = computed(() => selectedRole.value?.isSystem ? `server-policy-${selectedRole.value.key}` : null)

const tabs = computed(() => [
  { value: 'display' as const, label: 'Display' },
  { value: 'permissions' as const, label: 'Policies' },
  { value: 'members' as const, label: 'Members', count: selectedRole.value?.memberCount ?? roleMembers.value.length },
])

function roleLabel(role: Pick<RoleDTO, 'name'>) {
  if (role.name === 'owner') return 'Owner'
  if (role.name === 'admin') return 'Admin'
  if (role.name === 'member') return 'Member'
  return role.name
}

function permissionSummary(role: RoleDTO) {
  const count = role.policyCount ?? 0
  return `${count} ${count === 1 ? 'policy' : 'policies'}`
}

const roleName = ref('')
const saving = ref(false)
const creating = ref(false)
const createOpen = ref(false)
const newRoleName = ref('')
function showCreateRole() { newRoleName.value = ''; createOpen.value = true }
defineExpose({ createRole: showCreateRole })
const deleteOpen = ref(false)
const deleting = ref(false)

function resetDraft() {
  const role = selectedRole.value
  roleName.value = role ? roleLabel(role) : ''
}
watch(selectedRole, resetDraft, { immediate: true })

const dirty = computed(() => {
  const role = selectedRole.value
  if (!role || readOnly.value) return false
  return roleName.value.trim() !== roleLabel(role)
})

function openRole(role: RoleDTO) {
  selectedRoleId.value = role.id
  tab.value = 'permissions'
  memberQuery.value = ''
}

function backToList() {
  selectedRoleId.value = null
}

const policiesQ = useQuery({ queryKey: computed(() => ['project-policies', props.serverId]), queryFn: () => api<{ policies: ProjectPolicy[] }>(`/api/servers/${props.serverId}/project-policies`) })
const rolePoliciesQ = useQuery({ queryKey: computed(() => ['role-policies', props.serverId, selectedRoleId.value]), queryFn: () => api<{ policyIds: string[] }>(`/api/servers/${props.serverId}/roles/${selectedRoleId.value}/policies`), enabled: computed(() => Boolean(selectedRoleId.value)) })
const rolePolicyIds = ref<string[]>([])
const policySaving = ref(false)
watch(() => rolePoliciesQ.data.value, value => { rolePolicyIds.value = [...(value?.policyIds ?? [])] }, { immediate: true })
const policiesDirty = computed(() => [...rolePolicyIds.value].sort().join('\0') !== [...(rolePoliciesQ.data.value?.policyIds ?? [])].sort().join('\0'))
function togglePolicy(id: string, enabled: boolean) { rolePolicyIds.value = enabled ? [...rolePolicyIds.value, id] : rolePolicyIds.value.filter(item => item !== id) }
async function savePolicies() {
  if (!selectedRoleId.value) return
  policySaving.value = true
  try {
    await api(`/api/servers/${props.serverId}/roles/${selectedRoleId.value}/policies`, { method: 'PUT', body: { policyIds: rolePolicyIds.value } })
    await Promise.all([rolePoliciesQ.refetch(), refreshRoles()])
    toast.add({ title: 'Role policies saved', color: 'success' })
  } catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { policySaving.value = false }
}

async function refreshRoles() {
  await Promise.all([
    qc.invalidateQueries({ queryKey: ['roles', props.serverId] }),
    qc.invalidateQueries({ queryKey: ['members', props.serverId] }),
  ])
}

async function createRole() {
  if (creating.value || !newRoleName.value.trim()) return
  creating.value = true
  try {
    const name = newRoleName.value.trim()
    const res = await api<{ role: RoleDTO }>(`/api/servers/${props.serverId}/roles`, {
      method: 'POST',
      body: { name },
    })
    createOpen.value = false
    await qc.invalidateQueries({ queryKey: ['roles', props.serverId] })
    selectedRoleId.value = res.role.id
    tab.value = 'display'
  }
  catch (err) {
    toast.add({ title: errorMessage(err), color: 'error' })
  }
  finally {
    creating.value = false
  }
}

async function saveRole() {
  const role = selectedRole.value
  if (!role || readOnly.value || !roleName.value.trim()) return
  saving.value = true
  try {
    await api(`/api/servers/${props.serverId}/roles/${role.id}`, {
      method: 'PATCH',
      body: { name: roleName.value.trim() },
    })
    await refreshRoles()
    toast.add({ title: 'Role saved', color: 'success' })
  }
  catch (err) {
    toast.add({ title: errorMessage(err), color: 'error' })
  }
  finally {
    saving.value = false
  }
}

async function deleteRole() {
  const role = selectedRole.value
  if (!role) return
  deleting.value = true
  try {
    await api(`/api/servers/${props.serverId}/roles/${role.id}`, { method: 'DELETE' })
    deleteOpen.value = false
    selectedRoleId.value = null
    await refreshRoles()
    toast.add({ title: 'Role deleted', color: 'success' })
  }
  catch (err) {
    toast.add({ title: errorMessage(err), color: 'error' })
  }
  finally {
    deleting.value = false
  }
}

const deleteConsequence = computed(() => {
  const count = selectedRole.value?.memberCount ?? 0
  if (!count) return 'No one has this role, so nothing else changes.'
  return count === 1 ? 'Its 1 member moves to the Member role.' : `Its ${count} members move to the Member role.`
})

// Members of the selected role, and assigning people to it.
const memberQuery = ref('')
const assigningId = ref<string | null>(null)
const memberRole = computed(() => roles.value.find(role => role.key === 'member') ?? null)
const roleMembers = computed(() => members.value.filter(member => member.role.id === selectedRoleId.value))
const filteredRoleMembers = computed(() => {
  const term = memberQuery.value.trim().toLocaleLowerCase()
  if (!term) return roleMembers.value
  return roleMembers.value.filter(member => memberName(member).toLocaleLowerCase().includes(term))
})
// Owners cannot be reassigned, and only the owner hands out the Admin role.
const canAssignSelected = computed(() => {
  const role = selectedRole.value
  if (!role || !canManage.value || role.key === 'owner') return false
  return role.key !== 'admin' || isOwner.value
})
const assignableMembers = computed(() => members.value
  .filter(member => member.role.id !== selectedRoleId.value && member.role.key !== 'owner')
  .map(member => ({ label: memberName(member), value: member.user.id, description: roleLabel(member.role) })))

function memberName(member: MemberDTO) {
  return member.nickname || member.user.displayName
}

async function assign(userId: string, roleId: string) {
  if (assigningId.value) return
  assigningId.value = userId
  try {
    await api(`/api/servers/${props.serverId}/members/${userId}`, { method: 'PATCH', body: { roleId } })
    await refreshRoles()
  }
  catch (err) {
    toast.add({ title: errorMessage(err), color: 'error' })
  }
  finally {
    assigningId.value = null
  }
}

const addMemberId = ref<string | undefined>(undefined)
watch(addMemberId, async (userId) => {
  if (!userId || !selectedRoleId.value) return
  await assign(userId, selectedRoleId.value)
  addMemberId.value = undefined
})
</script>

<template>
  <div>
    <SettingsEditor v-model:open="createOpen" back="Roles &amp; Policies" title="Create role" :dismissible="!creating">
      <template #body><UForm :state="{ name: newRoleName }" class="space-y-4" @submit="createRole"><UFormField label="Name" help="New roles start without policies. Choose policies after creation."><UInput v-model="newRoleName" autofocus maxlength="80" class="w-full" /></UFormField><UButton type="submit" label="Create role" :disabled="!newRoleName.trim()" :loading="creating" /></UForm></template>
    </SettingsEditor>
    <!-- Role list -->
    <template v-if="!selectedRole">
      <SettingsList
        :items="roles"
        :item-key="role => role.id"
        :search-text="role => roleLabel(role)"
        :loading="rolesQ.isPending.value"
        placeholder="Search roles"
        :noun="['role', 'roles']"
        @select="openRole"
      >
        <template #row="{ item: role }">
          <span class="flex size-8 shrink-0 items-center justify-center rounded-md bg-elevated text-muted">
            <UIcon :name="role.key === 'owner' ? 'i-ph-crown-simple' : role.isSystem ? 'i-ph-shield-check' : 'i-ph-shield'" class="size-4" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="flex items-center gap-2">
              <span class="truncate text-sm font-medium text-highlighted">{{ roleLabel(role) }}</span>
              <UBadge v-if="role.isSystem" label="System" color="neutral" variant="subtle" size="sm" />
            </span>
            <span class="block truncate text-xs text-muted">{{ permissionSummary(role) }}</span>
          </span>
          <span class="flex shrink-0 items-center gap-1 text-xs text-muted tabular-nums">
            <UIcon name="i-ph-users" class="size-3.5" />
            {{ role.memberCount ?? 0 }}
          </span>
        </template>
      </SettingsList>
    </template>

    <!-- Role detail -->
    <template v-else>
      <SettingsHeader :title="roleLabel(selectedRole)" back="Roles & Policies" @back="backToList">
        <template #badge>
          <UBadge v-if="selectedRole.isSystem" label="System" color="neutral" variant="subtle" size="sm" />
        </template>
      </SettingsHeader>
      <p v-if="selectedRole.isSystem" class="mt-1 text-sm text-muted">
        {{ selectedRole.key === 'owner' ? 'The Owner role is built in and has every permission. You can change who has it.' : isOwner ? 'System roles are built in. Their name and built-in policy are fixed; you can add policies, for example to let every member use agents.' : 'System roles are built in. Only the Server Owner can add policies to them.' }}
      </p>

      <UButton v-if="!readOnly" class="mt-3" label="Save changes" :loading="saving" :disabled="!dirty || !roleName.trim()" @click="saveRole" />
      <LayoutSegmentedTabs v-model="tab" :items="tabs" label="Role settings" class="mt-5" />

      <div v-if="tab === 'display'" class="mt-6 space-y-6">
        <UFormField label="Role name" :help="readOnly ? undefined : 'Shown in the member list and role pickers.'">
          <UInput v-model="roleName" class="w-full max-w-md" :disabled="readOnly" maxlength="40" />
        </UFormField>
        <div v-if="!selectedRole.isSystem && canManage" class="rounded-lg border border-error/30 p-4">
          <p class="text-sm font-medium text-highlighted">Delete role</p>
          <p class="mt-1 text-sm text-muted">{{ deleteConsequence }}</p>
          <UButton class="mt-3" color="error" variant="soft" size="sm" label="Delete role" @click="deleteOpen = true" />
        </div>
      </div>

      <div v-else-if="tab === 'permissions'" class="mt-6 space-y-4">
        <p class="text-sm text-muted">Policies define what this role can do.</p>
        <LayoutLoadError v-if="policiesQ.error.value || rolePoliciesQ.error.value" message="Policies did not load." :retry="() => { policiesQ.refetch(); rolePoliciesQ.refetch() }" />
        <div class="divide-y divide-default overflow-hidden rounded-lg border border-default">
          <label v-for="policy in policiesQ.data.value?.policies ?? []" :key="policy.id" class="flex items-center justify-between gap-4 px-4 py-3">
            <span class="min-w-0"><span class="block text-sm font-medium">{{ policy.name }}</span><span class="block text-xs text-muted">{{ policy.description }}</span></span>
            <UCheckbox :model-value="rolePolicyIds.includes(policy.id)" :disabled="policiesReadOnly || policySaving || policy.id === lockedPolicy" :aria-label="policy.name" @update:model-value="togglePolicy(policy.id, Boolean($event))" />
          </label>
        </div>
        <UButton v-if="!policiesReadOnly" label="Save policies" :loading="policySaving" :disabled="!policiesDirty" @click="savePolicies" />
      </div>

      <div v-else class="mt-6">
        <div class="flex flex-wrap items-center gap-2">
          <UInput v-model="memberQuery" icon="i-ph-magnifying-glass" placeholder="Search members" aria-label="Search members" class="min-w-0 flex-1" />
          <USelectMenu
            v-if="canAssignSelected"
            v-model="addMemberId"
            :items="assignableMembers"
            value-key="value"
            placeholder="Add members"
            :search-input="{ placeholder: 'Find a member' }"
            icon="i-ph-user-plus"
            class="w-48"
            :loading="Boolean(assigningId)"
            :disabled="Boolean(assigningId) || !assignableMembers.length"
          />
        </div>
        <p v-if="!roleMembers.length" class="mt-4 rounded-lg border border-dashed border-default px-4 py-6 text-center text-sm text-muted">
          No one has this role yet.
        </p>
        <p v-else-if="!filteredRoleMembers.length" class="mt-4 rounded-lg border border-dashed border-default px-4 py-6 text-center text-sm text-muted">
          Nothing matches “{{ memberQuery }}”.
        </p>
        <ul v-else class="mt-4 divide-y divide-default rounded-lg border border-default">
          <li v-for="member in filteredRoleMembers" :key="member.user.id" class="flex items-center gap-3 px-4 py-2.5">
            <UserAvatar :user="member.user" size="sm" />
            <span class="min-w-0 flex-1 truncate text-sm text-default">{{ memberName(member) }}</span>
            <UButton
              v-if="canAssignSelected && memberRole && selectedRole.key !== 'member'"
              size="xs"
              color="neutral"
              variant="ghost"
              icon="i-ph-x"
              :aria-label="`Remove ${memberName(member)} from ${roleLabel(selectedRole)}`"
              :loading="assigningId === member.user.id"
              @click="assign(member.user.id, memberRole.id)"
            />
          </li>
        </ul>
      </div>

      <LayoutSaveBar :dirty="dirty" :saving="saving" :disabled="!roleName.trim()" @save="saveRole" @reset="resetDraft" />
    </template>

    <UModal v-model:open="deleteOpen" title="Delete this role?">
      <template #body>
        <p class="text-sm text-muted">Members using it will move to the Member role.</p>
      </template>
      <template #footer>
        <UButton color="neutral" variant="outline" label="Cancel" @click="deleteOpen = false" />
        <UButton color="error" label="Delete role" :loading="deleting" @click="deleteRole" />
      </template>
    </UModal>
  </div>
</template>
