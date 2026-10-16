<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { MemberDTO, RoleDTO } from '~~/shared/types'
import { hasPermission, MemberPermissions, Permission, permissionBitmask, PermissionGrants, type PermissionGrantKey } from '~~/shared/permissions'

const props = defineProps<{ workspaceId: string }>()

const { api } = useApi()
const qc = useQueryClient()
const toast = useToast()

const rolesQ = useQuery({
  queryKey: computed(() => ['roles', props.workspaceId]),
  queryFn: () => api<{ roles: RoleDTO[] }>(`/api/workspaces/${props.workspaceId}/roles`),
  enabled: computed(() => Boolean(props.workspaceId)),
})
const membersQ = useQuery({
  queryKey: computed(() => ['members', props.workspaceId]),
  queryFn: () => api<{ members: MemberDTO[] }>(`/api/workspaces/${props.workspaceId}/members`),
  enabled: computed(() => Boolean(props.workspaceId)),
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
const readOnly = computed(() => !selectedRole.value || selectedRole.value.isSystem || !canManage.value)

const tabs = computed(() => [
  { value: 'display' as const, label: 'Display' },
  { value: 'permissions' as const, label: 'Permissions' },
  { value: 'members' as const, label: 'Members', count: selectedRole.value?.memberCount ?? roleMembers.value.length },
])

// Grants grouped by what they govern, so a role reads as a policy rather than a flat list.
const grantGroups: Array<{ label: string, keys: PermissionGrantKey[] }> = [
  { label: 'Workspace', keys: ['manageWorkspace', 'manageChannels', 'manageRoles', 'invite', 'kick'] },
  { label: 'Conversations', keys: ['sendMessages', 'attachFiles', 'startLive'] },
  { label: 'Tools', keys: ['manageTasks', 'manageDatabases', 'useGadgets', 'manageGadgets'] },
]
const groupedGrants = grantGroups.map(group => ({
  label: group.label,
  grants: group.keys.map(key => PermissionGrants.find(grant => grant.key === key)!).filter(Boolean),
}))

function roleLabel(role: Pick<RoleDTO, 'name'>) {
  if (role.name === 'owner') return 'Owner'
  if (role.name === 'admin') return 'Admin'
  if (role.name === 'member') return 'Member'
  return role.name
}

function grantCount(permissions: number) {
  return PermissionGrants.filter(grant => hasPermission(permissions, grant.flag)).length
}

function permissionSummary(role: RoleDTO) {
  const count = grantCount(role.permissions)
  if (role.key === 'owner' || count === PermissionGrants.length) return 'All permissions'
  return `${count} of ${PermissionGrants.length} permissions`
}

// Draft edits, compared against the saved role to drive the save bar.
const roleName = ref('')
const rolePermissions = ref(0)
const saving = ref(false)
const creating = ref(false)
const deleteOpen = ref(false)
const deleting = ref(false)

function resetDraft() {
  const role = selectedRole.value
  roleName.value = role ? roleLabel(role) : ''
  rolePermissions.value = role?.permissions ?? 0
}
watch(selectedRole, resetDraft, { immediate: true })

const dirty = computed(() => {
  const role = selectedRole.value
  if (!role || readOnly.value) return false
  return roleName.value.trim() !== roleLabel(role) || rolePermissions.value !== role.permissions
})

function openRole(role: RoleDTO) {
  selectedRoleId.value = role.id
  tab.value = 'permissions'
  memberQuery.value = ''
}

function backToList() {
  selectedRoleId.value = null
}

function toggleGrant(key: PermissionGrantKey, enabled: boolean) {
  const active = PermissionGrants
    .filter(grant => grant.key !== key && hasPermission(rolePermissions.value, grant.flag))
    .map(grant => grant.key)
  if (enabled) active.push(key)
  rolePermissions.value = permissionBitmask(active)
}

function setGroup(keys: PermissionGrantKey[], enabled: boolean) {
  const active = new Set(PermissionGrants.filter(grant => hasPermission(rolePermissions.value, grant.flag)).map(grant => grant.key))
  for (const key of keys) {
    if (enabled) active.add(key)
    else active.delete(key)
  }
  rolePermissions.value = permissionBitmask(active)
}

async function refreshRoles() {
  await Promise.all([
    qc.invalidateQueries({ queryKey: ['roles', props.workspaceId] }),
    qc.invalidateQueries({ queryKey: ['members', props.workspaceId] }),
  ])
}

async function createRole() {
  creating.value = true
  try {
    const names = new Set(roles.value.map(role => role.name.toLocaleLowerCase()))
    let name = 'New role'
    let suffix = 2
    while (names.has(name.toLocaleLowerCase())) name = `New role ${suffix++}`
    const res = await api<{ role: RoleDTO }>(`/api/workspaces/${props.workspaceId}/roles`, {
      method: 'POST',
      body: { name, permissions: MemberPermissions },
    })
    await qc.invalidateQueries({ queryKey: ['roles', props.workspaceId] })
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
    await api(`/api/workspaces/${props.workspaceId}/roles/${role.id}`, {
      method: 'PATCH',
      body: { name: roleName.value.trim(), permissions: rolePermissions.value },
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
    await api(`/api/workspaces/${props.workspaceId}/roles/${role.id}`, { method: 'DELETE' })
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
  .filter(member => member.role.id !== selectedRoleId.value && member.role.key !== 'owner' && member.user.kind !== 'agent')
  .map(member => ({ label: memberName(member), value: member.user.id, description: roleLabel(member.role) })))

function memberName(member: MemberDTO) {
  return member.nickname || member.user.displayName
}

async function assign(userId: string, roleId: string) {
  assigningId.value = userId
  try {
    await api(`/api/workspaces/${props.workspaceId}/members/${userId}`, { method: 'PATCH', body: { roleId } })
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
    <!-- Role list -->
    <template v-if="!selectedRole">
      <SettingsHeader title="Roles" description="Every member has one role. A role decides what its members can do across the workspace.">
        <template #actions>
          <UButton v-if="canManage" icon="i-ph-plus" label="Create role" size="sm" :loading="creating" @click="createRole" />
        </template>
      </SettingsHeader>

      <SettingsList
        class="mt-6"
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
      <SettingsHeader :title="roleLabel(selectedRole)" back="Roles" @back="backToList">
        <template #badge>
          <UBadge v-if="selectedRole.isSystem" label="System" color="neutral" variant="subtle" size="sm" />
        </template>
      </SettingsHeader>
      <p v-if="selectedRole.isSystem" class="mt-1 text-sm text-muted">
        System roles are built in. Their name and permissions are fixed, but you can change who has them.
      </p>

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

      <div v-else-if="tab === 'permissions'" class="mt-6 space-y-8">
        <section v-for="group in groupedGrants" :key="group.label">
          <div class="mb-1 flex items-center justify-between gap-3">
            <h2 class="text-[11px] font-bold uppercase tracking-wide text-muted">{{ group.label }}</h2>
            <div v-if="!readOnly" class="flex gap-1">
              <UButton size="xs" color="neutral" variant="ghost" label="All" @click="setGroup(group.grants.map(grant => grant.key), true)" />
              <UButton size="xs" color="neutral" variant="ghost" label="None" @click="setGroup(group.grants.map(grant => grant.key), false)" />
            </div>
          </div>
          <div class="divide-y divide-default rounded-lg border border-default">
            <label
              v-for="grant in group.grants"
              :key="grant.key"
              class="flex items-start justify-between gap-6 px-4 py-3"
              :class="readOnly ? '' : 'cursor-pointer hover:bg-elevated/40'"
            >
              <span class="min-w-0">
                <span class="block text-sm font-medium text-highlighted">{{ grant.label }}</span>
                <span class="mt-0.5 block text-xs text-muted">{{ grant.description }}</span>
              </span>
              <USwitch
                :model-value="hasPermission(rolePermissions, grant.flag)"
                :disabled="readOnly"
                :aria-label="grant.label"
                @update:model-value="toggleGrant(grant.key, Boolean($event))"
              />
            </label>
          </div>
        </section>
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
            :disabled="!assignableMembers.length"
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
