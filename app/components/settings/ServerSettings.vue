<script setup lang="ts">
import { publicIconPath } from '~~/shared/server-appearance'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { TableColumn } from '@nuxt/ui'
import type { AuditEntryDTO, ChannelCategoryDTO, ChannelDTO, ChannelRoleOverrideDTO, ServerDTO, MemberDTO, RoleDTO } from '~~/shared/types'
import type { UpdateStatusDTO } from '~~/shared/releases'
import { channelPermissionMasks, channelPermissionMode, ChannelPermissionGrants, type ChannelPermissionGrantKey, type ChannelPermissionMode } from '~~/shared/channel-permissions'
import { Permission } from '~~/shared/permissions'
import { formatDateTime } from '~~/shared/format'
import { useClipboard } from '@vueuse/core'


const props = defineProps<{ serverId: string }>()
const { api, serverUrl } = useApi()
const open = defineModel<boolean>('open', { default: false })

const toast = useToast()
const session = useSessionStore()
const qc = useQueryClient()
const { copy } = useClipboard()
/** Exposed so `/server/:id/settings?section=…` can deep-link, and so the section survives reopening. */
const section = defineModel<string>('section', { default: 'overview' })

const saving = ref(false)
const memberChannelId = ref<string | null>(null)
const permissionChannelId = ref<string | null>(null)
const permissionRoleId = ref<string | null>(null)
const permissionModes = reactive<Record<ChannelPermissionGrantKey, ChannelPermissionMode>>({
  sendMessages: 'inherit',
  attachFiles: 'inherit',
  startLive: 'inherit',
})
const permissionSaving = ref(false)

const serverQ = useQuery({
  queryKey: computed(() => ['server', props.serverId]),
  queryFn: () => api<{ server: ServerDTO }>(`/api/servers/${props.serverId}`),
  enabled: computed(() => Boolean(props.serverId) && open.value),
})
const membersQ = useQuery({
  queryKey: computed(() => ['members', props.serverId]),
  queryFn: () => api<{ members: MemberDTO[] }>(`/api/servers/${props.serverId}/members`),
  enabled: computed(() => Boolean(props.serverId) && open.value),
})
const { can, mine } = usePermissions(computed(() => membersQ.data.value?.members))
const rolesQ = useQuery({
  queryKey: computed(() => ['roles', props.serverId]),
  queryFn: () => api<{ roles: RoleDTO[] }>(`/api/servers/${props.serverId}/roles`),
  enabled: computed(() => Boolean(props.serverId) && open.value && (can(Permission.manageRoles) || can(Permission.manageChannels))),
})
const channelsQ = useQuery({
  queryKey: computed(() => ['channels', props.serverId]),
  queryFn: () => api<{ categories: ChannelCategoryDTO[]; channels: ChannelDTO[] }>(`/api/servers/${props.serverId}/channels`),
  enabled: computed(() => Boolean(props.serverId) && open.value),
})
const channelOverridesQ = useQuery({
  queryKey: computed(() => ['channel-role-overrides', permissionChannelId.value]),
  queryFn: () => api<{ overrides: ChannelRoleOverrideDTO[] }>(`/api/channels/${permissionChannelId.value}/role-overrides`),
  enabled: computed(() => Boolean(props.serverId) && open.value && section.value === 'channels' && Boolean(permissionChannelId.value)),
})
const invitesQ = useQuery({
  queryKey: computed(() => ['invites', props.serverId]),
  queryFn: () => api<{ invites: Array<{ code: string; url: string; maxUses: number; uses: number; expiresAt: string | null; createdAt: string }> }>(`/api/servers/${props.serverId}/invites`),
  enabled: computed(() => Boolean(props.serverId) && open.value && section.value === 'invites'),
})
const auditQ = useQuery({
  queryKey: computed(() => ['audit', props.serverId]),
  queryFn: () => api<{ entries: AuditEntryDTO[] }>(`/api/servers/${props.serverId}/audit`),
  enabled: computed(() => Boolean(props.serverId) && open.value && section.value === 'audit'),
})
const isOwner = computed(() => mine.value?.role.key === 'owner')
const updatesQ = useQuery({
  queryKey: computed(() => ['updates', props.serverId]),
  queryFn: () => api<UpdateStatusDTO>(`/api/servers/${props.serverId}/updates`),
  enabled: computed(() => Boolean(props.serverId) && open.value && isOwner.value),
  staleTime: 6 * 60 * 60 * 1000,
})


const serverNav = computed(() => [
  ...(can(Permission.manageServer) ? [{ id: 'overview' as const, label: 'Overview', icon: 'i-ph-house', keywords: ['name', 'icon', 'rename'] }] : []),
  ...(can(Permission.manageChannels) ? [{ id: 'channels' as const, label: 'Channels', icon: 'i-ph-hash', keywords: ['categories', 'private'] }] : []),
  ...(can(Permission.manageRoles) ? [{ id: 'roles' as const, label: 'Roles', icon: 'i-ph-shield', keywords: ['permissions', 'admin', 'access'] }] : []),
  ...(can(Permission.manageRoles) ? [{ id: 'project-policies' as const, label: 'Project policies', icon: 'i-ph-shield-check', keywords: ['projects', 'developer', 'reviewer', 'permissions'] }] : []),
  ...(can(Permission.manageRoles) || can(Permission.kick) ? [{ id: 'members' as const, label: 'Members', icon: 'i-ph-users', keywords: ['people', 'kick', 'assign role'] }] : []),
  ...(can(Permission.invite) && session.health?.authMode !== 'access' ? [{ id: 'invites' as const, label: 'Invites', icon: 'i-ph-user-plus', keywords: ['invite link', 'join', 'share'] }] : []),
])
const featureNav = computed(() => [
  ...(can(Permission.useAgents) || can(Permission.manageAgents) || can(Permission.useExternalTools) ? [{ id: 'tools' as const, label: 'Tools', icon: 'i-ph-wrench', keywords: ['mcp', 'connections', 'capabilities', 'permissions', 'approvals'] }] : []),
  ...(can(Permission.manageServer) ? [{ id: 'environments' as const, label: 'Repositories', icon: 'i-ph-git-branch', keywords: ['agents', 'code', 'github', 'fork'] }] : []),
  ...(can(Permission.manageAgents) ? [{ id: 'agents' as const, label: 'Agents', icon: 'i-ph-robot', keywords: ['bots', 'automation', 'tasks'] }] : []),
  ...(isOwner.value ? [{ id: 'storage' as const, label: 'Storage', icon: 'i-ph-hard-drives', keywords: ['files', 'kv', 'r2', 'quota'] }] : []),
  ...(isOwner.value ? [{ id: 'live' as const, label: 'Live', icon: 'i-ph-waveform', keywords: ['calls', 'video', 'audio', 'screen share', 'realtimekit'] }] : []),
  ...(can(Permission.manageServer) ? [{ id: 'email' as const, label: 'Email', icon: 'i-ph-envelope-simple', keywords: ['mail', 'mailbox', 'inbox', 'domain'] }] : []),
])
const accessNav = computed(() => [
  ...(isOwner.value ? [{ id: 'authentication' as const, label: 'Authentication', icon: 'i-ph-key', keywords: ['login', 'signup', 'oauth', 'github', 'sso', 'registration'] }] : []),
  ...(isOwner.value ? [{ id: 'onboarding' as const, label: 'Onboarding', icon: 'i-ph-flag-banner', keywords: ['welcome', 'first run', 'branding'] }] : []),
  ...(can(Permission.manageServer) ? [{ id: 'audit' as const, label: 'Audit Log', icon: 'i-ph-list-magnifying-glass', keywords: ['history', 'activity', 'log'] }] : []),
])
const deploymentSections = ['cloudflare', 'domains', 'backups', 'updates', 'danger']
const deploymentNav = computed(() => isOwner.value
  ? [{
      id: 'cloudflare' as const,
      label: 'Deployment',
      icon: 'i-ph-hard-drives',
      aliases: deploymentSections,
      badge: updatesQ.data.value?.updateAvailable ? String(updatesQ.data.value.releasesBehind) : undefined,
      keywords: [
        'cloudflare', 'server', 'management', 'managed', 'manual', 'deployment',
        'domain', 'app domain', 'custom domain', 'address', 'url', 'dns', 'zone',
        'backup', 'download', 'export', 'restore', 'd1', 'r2',
        'updates', 'release', 'version', 'upgrade', 'github',
        'danger', 'delete server', 'remove', 'destroy', 'uninstall',
      ],
    }]
  : [])
const groups = computed(() => [
  { label: 'Server', items: serverNav.value },
  { label: 'Features', items: featureNav.value },
  { label: 'Access', items: accessNav.value },
  { items: deploymentNav.value },
].filter(group => group.items.length))
const availableSections = computed(() => groups.value.flatMap(group => group.items.flatMap(item => 'aliases' in item ? item.aliases : [item.id])))


// Sections depend on the member's permissions; until those load, keep the
// requested (deep-linked) section instead of falling back to the first one.
watch([open, availableSections, mine], ([isOpen, sections, member]) => {
  if (isOpen && member && !sections.includes(section.value)) {
    section.value = sections[0] ?? 'overview'
  }
}, { immediate: true })

const inviteUrl = ref('')
const inviting = ref(false)
const kickId = ref<string | null>(null)
const assigningId = ref<string | null>(null)
const serverIconInput = ref<HTMLInputElement | null>(null)
const serverIconBusy = ref(false)
const createCategoryOpen = ref(false)
const newCategoryName = ref('')
const categoryCreating = ref(false)
const selectedCategoryId = ref<string | null>(null)
const categoryName = ref('')
const categorySaving = ref(false)
const editCategoryOpen = ref(false)
const moveChannelId = ref<string | null>(null)
const moveCategoryId = ref('uncategorized')
const movingChannel = computed(() => serverChannels.value.find(channel => channel.id === moveChannelId.value) ?? null)
const categoryDeleteId = ref<string | null>(null)
const channelAssigningId = ref<string | null>(null)

const roles = computed(() => rolesQ.data.value?.roles ?? [])
const categories = computed(() => channelsQ.data.value?.categories ?? [])
const serverChannels = computed(() => (channelsQ.data.value?.channels ?? []).filter(channel => channel.type !== 'dm' && channel.type !== 'thread'))
const selectedCategory = computed(() => categories.value.find(category => category.id === selectedCategoryId.value) ?? null)
const categoryOptions = computed(() => [
  { label: 'Uncategorized', value: 'uncategorized' },
  ...categories.value.map(category => ({ label: category.name, value: category.id })),
])
const roleOptions = computed(() => roles.value
  .filter(role => role.key !== 'owner' && (role.key !== 'admin' || isOwner.value))
  .map(role => ({ label: roleLabel(role.name), value: role.id })))
const memberChannel = computed(() => serverChannels.value.find(channel => channel.id === memberChannelId.value) ?? null)
const permissionChannel = computed(() => serverChannels.value.find(channel => channel.id === permissionChannelId.value) ?? null)
const permissionRoleOptions = computed(() => roles.value
  .filter(role => role.key !== 'owner')
  .map(role => ({ label: roleLabel(role.name), value: role.id })))
const selectedPermissionOverride = computed(() => channelOverridesQ.data.value?.overrides
  .find(override => override.roleId === permissionRoleId.value) ?? null)
const overrideModeOptions = [
  { label: 'Inherit', value: 'inherit' },
  { label: 'Allow', value: 'allow' },
  { label: 'Deny', value: 'deny' },
]

watch([categories, section], ([list, activeSection]) => {
  if (activeSection !== 'channels') return
  if (!selectedCategoryId.value || !list.some(category => category.id === selectedCategoryId.value)) {
    selectedCategoryId.value = list[0]?.id ?? null
  }
}, { immediate: true })

watch(selectedCategory, (category) => {
  categoryName.value = category?.name ?? ''
}, { immediate: true })

watch([serverChannels, section], ([list, activeSection]) => {
  if (activeSection !== 'channels') return
  if (permissionChannelId.value && !list.some(channel => channel.id === permissionChannelId.value)) {
    permissionChannelId.value = null
  }
})

watch([permissionRoleOptions, permissionChannelId], ([options, channelId]) => {
  if (!channelId) return
  if (!permissionRoleId.value || !options.some(option => option.value === permissionRoleId.value)) {
    permissionRoleId.value = options.find(option => roles.value.find(role => role.id === option.value)?.key === 'member')?.value
      ?? options[0]?.value
      ?? null
  }
}, { immediate: true })

watch([selectedPermissionOverride, permissionRoleId], ([override]) => {
  const allow = override?.allow ?? 0
  const deny = override?.deny ?? 0
  for (const grant of ChannelPermissionGrants) {
    permissionModes[grant.key] = channelPermissionMode(allow, deny, grant.flag)
  }
}, { immediate: true })

const memberCount = computed(() => membersQ.data.value?.members.length ?? 0)
const channelCount = computed(() => serverChannels.value.length)
const serverName = computed(() => serverQ.data.value?.server.name || 'Server')
const serverInitial = computed(() => serverName.value.slice(0, 1).toUpperCase())
const serverIconUrl = computed(() => {
  const server = serverQ.data.value?.server
  if (!server?.iconR2Key) return undefined
  return serverUrl(`${publicIconPath}?v=${encodeURIComponent(server.updatedAt)}`)
})

async function onSave(name: string) {
  if (saving.value || name === serverQ.data.value?.server.name) return
  saving.value = true
  try {
    await api(`/api/servers/${props.serverId}`, { method: 'PATCH', body: { name } })
    await qc.invalidateQueries({ queryKey: ['server', props.serverId] })
    toast.add({ title: 'Server updated', color: 'success' })
  }
  catch (err) {
    toast.add({ title: errorMessage(err), color: 'error' })
  }
  finally {
    saving.value = false
  }
}

async function uploadServerIcon(event: Event) {
  if ((session.health?.bindings.r2 === false && !session.health?.bindings.kv)) return
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  serverIconBusy.value = true
  try {
    const body = new FormData()
    body.append('file', file)
    await api(`/api/servers/${props.serverId}/icon`, { method: 'PUT', body })
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['server', props.serverId] }),
      qc.invalidateQueries({ queryKey: ['servers'] }),
    ])
    toast.add({ title: 'Server icon updated', color: 'success' })
  }
  catch (err) {
    toast.add({ title: errorMessage(err), color: 'error' })
  }
  finally {
    serverIconBusy.value = false
    input.value = ''
  }
}

async function removeServerIcon() {
  serverIconBusy.value = true
  try {
    await api(`/api/servers/${props.serverId}/icon`, { method: 'DELETE' })
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['server', props.serverId] }),
      qc.invalidateQueries({ queryKey: ['servers'] }),
    ])
    toast.add({ title: 'Server icon removed', color: 'success' })
  }
  catch (err) {
    toast.add({ title: errorMessage(err), color: 'error' })
  }
  finally {
    serverIconBusy.value = false
  }
}

async function createCategory() {
  const name = newCategoryName.value.trim()
  if (!name) return
  categoryCreating.value = true
  try {
    const result = await api<{ category: ChannelCategoryDTO }>(`/api/servers/${props.serverId}/categories`, {
      method: 'POST',
      body: { name },
    })
    await qc.invalidateQueries({ queryKey: ['channels', props.serverId] })
    selectedCategoryId.value = result.category.id
    newCategoryName.value = ''
    createCategoryOpen.value = false
    toast.add({ title: 'Category created', color: 'success' })
  }
  catch (err) {
    toast.add({ title: errorMessage(err), color: 'error' })
  }
  finally {
    categoryCreating.value = false
  }
}

async function saveCategory() {
  const category = selectedCategory.value
  const name = categoryName.value.trim()
  if (!category || !name) return
  categorySaving.value = true
  try {
    await api(`/api/servers/${props.serverId}/categories/${category.id}`, {
      method: 'PATCH',
      body: { name },
    })
    await qc.invalidateQueries({ queryKey: ['channels', props.serverId] })
    editCategoryOpen.value = false
    toast.add({ title: 'Category updated', color: 'success' })
  }
  catch (err) {
    toast.add({ title: errorMessage(err), color: 'error' })
  }
  finally {
    categorySaving.value = false
  }
}

async function confirmDeleteCategory() {
  const categoryId = categoryDeleteId.value
  if (!categoryId) return
  try {
    await api(`/api/servers/${props.serverId}/categories/${categoryId}`, { method: 'DELETE' })
    categoryDeleteId.value = null
    selectedCategoryId.value = null
    await qc.invalidateQueries({ queryKey: ['channels', props.serverId] })
    toast.add({ title: 'Category deleted', color: 'success' })
  }
  catch (err) {
    toast.add({ title: errorMessage(err), color: 'error' })
  }
}

async function assignChannelCategory(channelId: string, categoryId: string) {
  channelAssigningId.value = channelId
  try {
    await api(`/api/channels/${channelId}`, {
      method: 'PATCH',
      body: { categoryId: categoryId === 'uncategorized' ? null : categoryId },
    })
    await qc.invalidateQueries({ queryKey: ['channels', props.serverId] })
    moveChannelId.value = null
  }
  catch (err) {
    toast.add({ title: errorMessage(err), color: 'error' })
  }
  finally {
    channelAssigningId.value = null
  }
}

function editChannelPermissions(channelId: string) {
  permissionChannelId.value = channelId
}

async function saveChannelPermissions() {
  if (!permissionChannelId.value || !permissionRoleId.value) return
  permissionSaving.value = true
  try {
    const masks = channelPermissionMasks(permissionModes)
    await api(`/api/channels/${permissionChannelId.value}/role-overrides/${permissionRoleId.value}`, {
      method: 'PUT',
      body: masks,
    })
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['channel-role-overrides', permissionChannelId.value] }),
      qc.invalidateQueries({ queryKey: ['channel', permissionChannelId.value] }),
    ])
    toast.add({ title: 'Channel permissions updated', color: 'success' })
  }
  catch (err) {
    toast.add({ title: errorMessage(err), color: 'error' })
  }
  finally {
    permissionSaving.value = false
  }
}

async function resetChannelPermissions() {
  if (!permissionChannelId.value || !permissionRoleId.value) return
  permissionSaving.value = true
  try {
    await api(`/api/channels/${permissionChannelId.value}/role-overrides/${permissionRoleId.value}`, { method: 'DELETE' })
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['channel-role-overrides', permissionChannelId.value] }),
      qc.invalidateQueries({ queryKey: ['channel', permissionChannelId.value] }),
    ])
    toast.add({ title: 'Channel permissions reset', color: 'success' })
  }
  catch (err) {
    toast.add({ title: errorMessage(err), color: 'error' })
  }
  finally {
    permissionSaving.value = false
  }
}

async function makeInvite() {
  inviting.value = true
  try {
    const res = await api<{ invite: { url: string } }>(`/api/servers/${props.serverId}/invites`, { method: 'POST', body: {} })
    inviteUrl.value = serverUrl(res.invite.url)
    await qc.invalidateQueries({ queryKey: ['invites', props.serverId] })
  }
  catch (err) {
    toast.add({ title: errorMessage(err), color: 'error' })
  }
  finally {
    inviting.value = false
  }
}

async function copyInvite(url?: string) {
  const value = url || inviteUrl.value
  if (!value) return
  await copy(serverUrl(value))
  toast.add({ title: 'Invite copied', color: 'success' })
}

async function confirmKick() {
  if (!kickId.value) return
  await api(`/api/servers/${props.serverId}/members/${kickId.value}`, { method: 'DELETE' })
  await qc.invalidateQueries({ queryKey: ['members', props.serverId] })
  kickId.value = null
  toast.add({ title: 'Member kicked', color: 'success' })
}

async function assignRole(userId: string, roleId: string) {
  assigningId.value = userId
  try {
    await api(`/api/servers/${props.serverId}/members/${userId}`, { method: 'PATCH', body: { roleId } })
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['members', props.serverId] }),
      qc.invalidateQueries({ queryKey: ['roles', props.serverId] }),
    ])
    toast.add({ title: 'Member role updated', color: 'success' })
  }
  catch (err) {
    toast.add({ title: errorMessage(err), color: 'error' })
  }
  finally {
    assigningId.value = null
  }
}

const columns: TableColumn<AuditEntryDTO>[] = [
  { accessorKey: 'createdAt', header: 'When', cell: ({ row }) => formatDateTime(row.original.createdAt) },
  { accessorKey: 'actorName', header: 'Actor' },
  { accessorKey: 'action', header: 'Action' },
  { accessorKey: 'targetType', header: 'Target', cell: ({ row }) => `${row.original.targetType} ${row.original.targetId.slice(0, 8)}` },
]

function roleLabel(name: string) {
  if (name === 'owner') return 'Owner'
  if (name === 'admin') return 'Admin'
  if (name === 'member') return 'Member'
  return name
}

</script>

<template>
  <SettingsOverlay v-model:open="open" v-model:section="section" :groups="groups" :title="serverName" :loading="membersQ.isPending.value">
    <template v-if="section === 'overview'">
      <h1 class="text-xl font-semibold text-highlighted">Server Overview</h1>
      <div class="mt-8 flex flex-col items-start gap-6 sm:flex-row">
        <div class="flex shrink-0 flex-col items-center gap-2">
          <UAvatar size="3xl" :src="serverIconUrl" :text="serverInitial" :alt="serverName" />
          <input
            ref="serverIconInput"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            class="hidden"
            @change="uploadServerIcon"
          >
          <div v-if="can(Permission.manageServer)" class="flex items-center gap-1">
            <UButton
              size="xs"
              color="neutral"
              variant="soft"
              label="Change icon"
              :disabled="(session.health?.bindings.r2 === false && !session.health?.bindings.kv)"
              :loading="serverIconBusy"
              @click="serverIconInput?.click()"
            />
            <UTooltip v-if="serverQ.data.value?.server.iconR2Key" text="Remove icon">
              <UButton
                size="xs"
                color="error"
                variant="ghost"
                icon="i-ph-trash"
                aria-label="Remove server icon"
                :disabled="serverIconBusy"
                @click="removeServerIcon"
              />
            </UTooltip>
          </div>
        </div>
        <SettingsServerOverviewForm v-if="serverQ.data.value" :name="serverQ.data.value.server.name" :saving="saving" :editable="can(Permission.manageServer)" @save="onSave" />
      </div>
      <div class="mt-10 grid grid-cols-2 gap-4 max-w-md">
        <div class="rounded-lg bg-elevated p-4">
          <p class="text-[11px] font-bold uppercase tracking-wide text-muted">Members</p>
          <USkeleton v-if="membersQ.isPending.value" class="mt-2 h-7 w-10" />
          <p v-else class="text-2xl font-semibold text-highlighted mt-1">{{ memberCount }}</p>
        </div>
        <div class="rounded-lg bg-elevated p-4">
          <p class="text-[11px] font-bold uppercase tracking-wide text-muted">Channels</p>
          <USkeleton v-if="channelsQ.isPending.value" class="mt-2 h-7 w-10" />
          <p v-else class="text-2xl font-semibold text-highlighted mt-1">{{ channelCount }}</p>
        </div>
      </div>
    </template>

    <template v-else-if="section === 'channels'">
      <div class="flex items-center justify-between gap-3">
        <h1 class="text-xl font-semibold text-highlighted">Channel categories</h1>
        <UButton
          v-if="can(Permission.manageChannels)"
          icon="i-ph-plus"
          label="Add category"
          size="sm"
          @click="createCategoryOpen = true"
        />
      </div>
      <ul class="mt-6 divide-y divide-default">
        <li v-for="category in categories" :key="category.id">
          <button type="button" class="flex min-h-14 w-full items-center gap-3 rounded-lg px-3 py-3 text-start hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary" :aria-label="`Edit category ${category.name}`" @click="selectedCategoryId = category.id; categoryName = category.name; editCategoryOpen = true">
            <UIcon name="i-ph-folder" class="size-5 text-muted" />
            <span class="min-w-0 flex-1"><span class="block truncate text-sm font-medium text-highlighted">{{ category.name }}</span><span class="text-xs text-muted">{{ serverChannels.filter(channel => channel.categoryId === category.id).length }} channels</span></span>
            <UIcon name="i-ph-pencil-simple" class="size-4 text-muted" />
          </button>
        </li>
        <li v-if="!categories.length" class="py-4 text-sm text-muted">No categories yet.</li>
      </ul>
      <h2 class="mt-10 text-sm font-semibold text-highlighted">Channels</h2>
      <ul class="mt-2 divide-y divide-default">
        <li v-for="channel in serverChannels" :key="channel.id" class="flex items-center gap-3 py-3">
          <UIcon name="i-ph-hash" class="size-5 shrink-0 text-muted" />
          <span class="min-w-0 flex-1 truncate text-sm text-highlighted">{{ channel.name }}</span>
          <UButton
            v-if="can(Permission.manageChannels)"
            icon="i-ph-shield-check"
            label="Permissions"
            color="neutral"
            variant="ghost"
            size="xs"
            @click="editChannelPermissions(channel.id)"
          />
          <UButton v-if="channel.visibility === 'private' && channel.createdBy === session.user?.id" icon="i-ph-users" label="Members" color="neutral" variant="ghost" size="xs" :aria-label="`Manage members of ${channel.name}`" @click="memberChannelId = channel.id" />
          <UButton icon="i-ph-folder" label="Move" color="neutral" variant="ghost" size="sm" :aria-label="`Move ${channel.name} to a category`" @click="moveChannelId = channel.id; moveCategoryId = channel.categoryId || 'uncategorized'" />
        </li>
      </ul>
      <SettingsPrivateChannelMembers v-if="memberChannel" :open="true" :server-id="serverId" :channel="memberChannel" @update:open="value => { if (!value) memberChannelId = null }" />
      <SettingsChannelCreatorRecovery v-if="isOwner" :server-id="serverId" />
      <UModal :open="Boolean(permissionChannel)" title="Channel permissions" @update:open="value => { if (!value) permissionChannelId = null }"><template #body><div v-if="permissionChannel">
        <div class="flex items-center gap-3">
          <h2 class="min-w-0 flex-1 truncate text-sm font-semibold text-highlighted">
            {{ permissionChannel.name }} permissions
          </h2>
          <UButton
            icon="i-ph-x"
            color="neutral"
            variant="ghost"
            size="xs"
            square
            aria-label="Close channel permissions"
            @click="permissionChannelId = null"
          />
        </div>
        <UFormField label="Role" class="mt-4 max-w-xs">
          <USelect
            :model-value="permissionRoleId ?? undefined"
            :items="permissionRoleOptions"
            value-key="value"
            label-key="label"
            class="w-full"
            @update:model-value="permissionRoleId = $event ? String($event) : null"
          />
        </UFormField>
        <div class="mt-4 divide-y divide-default">
          <div v-for="grant in ChannelPermissionGrants" :key="grant.key" class="flex items-center gap-4 py-2">
            <span class="min-w-0 flex-1 text-sm text-default">{{ grant.label }}</span>
            <USelect
              v-model="permissionModes[grant.key]"
              :items="overrideModeOptions"
              value-key="value"
              label-key="label"
              size="sm"
              class="w-32"
              :aria-label="`${grant.label} override`"
            />
          </div>
        </div>
        <div class="mt-4 flex justify-end gap-2">
          <UButton
            v-if="selectedPermissionOverride"
            label="Reset"
            color="neutral"
            variant="ghost"
            :loading="permissionSaving"
            @click="resetChannelPermissions"
          />
          <UButton label="Save" :loading="permissionSaving" @click="saveChannelPermissions" />
        </div>
      </div></template></UModal>
    </template>

    <template v-else-if="section === 'tools'">
      <SettingsToolsSettings :server-id="serverId" @roles="section = 'roles'" />
    </template>

    <template v-else-if="section === 'roles'">
      <SettingsRolesSettings :server-id="serverId" />
    </template>
    <template v-else-if="section === 'project-policies'">
      <SettingsProjectPolicies :server-id="serverId" />
    </template>

    <template v-else-if="section === 'environments'">
      <SettingsCodeEnvironments :server-id="serverId" />
    </template>

    <template v-else-if="section === 'agents'">
      <SettingsAgentSettings :server-id="serverId" :is-owner="isOwner" @navigate="open = false" />
    </template>

    <template v-else-if="section === 'members'">
      <h1 class="text-xl font-semibold text-highlighted">Members</h1>
      <p class="mt-1 text-sm text-muted">{{ memberCount }} {{ memberCount === 1 ? 'member' : 'members' }} in this server.</p>
      <ul class="mt-6 divide-y divide-default">
        <li v-for="m in membersQ.data.value?.members ?? []" :key="m.user.id" class="flex items-center gap-3 py-3">
          <UserAvatar :user="m.user" size="sm" />
          <div class="min-w-0 flex-1">
            <p class="font-medium truncate">{{ m.nickname || m.user.displayName }}</p>
            <p class="text-xs text-muted">{{ roleLabel(m.role.name) }}</p>
          </div>
          <USelect
            v-if="can(Permission.manageRoles) && m.role.key !== 'owner'"
            :model-value="m.role.id"
            :items="roleOptions"
            value-key="value"
            label-key="label"
            size="sm"
            class="w-40"
            :loading="assigningId === m.user.id"
            aria-label="Assign role"
            @update:model-value="assignRole(m.user.id, String($event))"
          />
          <UButton
            v-if="can(Permission.kick) && m.role.name !== 'owner'"
            size="xs"
            color="error"
            variant="ghost"
            label="Kick"
            @click="kickId = m.user.id"
          />
        </li>
      </ul>
    </template>

    <template v-else-if="section === 'invites'">
      <h1 class="text-xl font-semibold text-highlighted">Invites</h1>
      <p class="mt-1 text-sm text-muted">Anyone with a link can join this server.</p>
      <div class="mt-6 flex gap-2 max-w-xl">
        <UInput :model-value="inviteUrl" readonly class="flex-1" placeholder="Create an invite to get a link" />
        <UButton v-if="inviteUrl" label="Copy" @click="copyInvite()" />
        <UButton v-if="can(Permission.invite)" :loading="inviting" label="Create Invite" @click="makeInvite" />
      </div>
      <ul v-if="invitesQ.data.value?.invites.length" class="mt-8 divide-y divide-default">
        <li v-for="inv in invitesQ.data.value.invites" :key="inv.code" class="flex items-center gap-3 py-3">
          <div class="min-w-0 flex-1">
            <p class="font-mono text-sm text-highlighted truncate">{{ inv.code }}</p>
            <p class="text-xs text-muted">
              {{ inv.uses }}{{ inv.maxUses ? ` / ${inv.maxUses}` : '' }} uses
              · {{ inv.expiresAt ? `expires ${formatDateTime(inv.expiresAt)}` : 'never expires' }}
            </p>
          </div>
          <UButton size="xs" color="neutral" variant="soft" label="Copy" @click="copyInvite(inv.url)" />
        </li>
      </ul>
    </template>

    <template v-else-if="section === 'storage'"><SettingsStorageSettings :server-id="serverId" /></template>
    <template v-else-if="section === 'live'">
      <SettingsRealtimeKitSettings :server-id="serverId" />
    </template>

    <template v-else-if="section === 'email'">
      <SettingsEmailSettings :server-id="serverId" />
    </template>

    <template v-else-if="section === 'authentication'">
      <SettingsAuthSettings :server-id="serverId" />
    </template>

    <template v-else-if="section === 'onboarding'">
      <SettingsOnboardingSettings :server-id="serverId" />
    </template>


    <template v-else-if="deploymentSections.includes(section)">
      <SettingsServerDeploymentSettings
        v-model:section="section"
        :server-id="serverId"
        :server-name="serverName"
        :updates-behind="updatesQ.data.value?.updateAvailable ? updatesQ.data.value.releasesBehind : undefined"
      />
    </template>

    <template v-else-if="section === 'audit'">
      <h1 class="text-xl font-semibold text-highlighted">Audit Log</h1>
      <LayoutSkeleton v-if="auditQ.isPending.value" variant="rows" :rows="6" class="mt-6" />
      <UAlert v-else-if="auditQ.error.value" color="error" title="Need manage permission." class="mt-6" />
      <UAlert v-else-if="!auditQ.data.value?.entries.length" color="neutral" title="Nothing yet." class="mt-6" />
      <UTable v-else class="mt-6" :data="auditQ.data.value.entries" :columns="columns" />
    </template>
  </SettingsOverlay>

  <UModal :open="Boolean(kickId)" title="Kick this member?" @update:open="(v: boolean) => { if (!v) kickId = null }">
    <template #footer>
      <UButton color="neutral" variant="outline" label="Cancel" @click="kickId = null" />
      <UButton color="error" label="Kick" @click="confirmKick" />
    </template>
  </UModal>
  <UModal v-model:open="editCategoryOpen" title="Edit category" :dismissible="!categorySaving">
    <template #body><UFormField label="Category name"><UInput v-model="categoryName" autofocus class="w-full" @keyup.enter="saveCategory" /></UFormField></template>
    <template #footer><UButton v-if="selectedCategory" color="error" variant="ghost" label="Delete category" @click="categoryDeleteId = selectedCategory.id; editCategoryOpen = false" /><UButton color="neutral" variant="ghost" label="Cancel" @click="editCategoryOpen = false" /><UButton label="Save changes" :loading="categorySaving" :disabled="!categoryName.trim()" @click="saveCategory" /></template>
  </UModal>
  <UModal :open="Boolean(movingChannel)" :title="`Move #${movingChannel?.name || 'channel'}`" @update:open="value => { if (!value) moveChannelId = null }">
    <template #body><UFormField label="Category" description="Choose the group where this channel appears in Chat."><USelect v-model="moveCategoryId" :items="categoryOptions" class="w-full" /></UFormField></template>
    <template #footer><UButton label="Cancel" color="neutral" variant="ghost" @click="moveChannelId = null" /><UButton label="Move channel" :loading="Boolean(channelAssigningId)" @click="moveChannelId && assignChannelCategory(moveChannelId, moveCategoryId)" /></template>
  </UModal>
  <UModal v-model:open="createCategoryOpen" title="Add category">
    <template #body>
      <UFormField label="Category name">
        <UInput v-model="newCategoryName" class="w-full" autofocus @keyup.enter="createCategory" />
      </UFormField>
    </template>
    <template #footer>
      <UButton color="neutral" variant="outline" label="Cancel" @click="createCategoryOpen = false" />
      <UButton label="Add category" :loading="categoryCreating" :disabled="!newCategoryName.trim()" @click="createCategory" />
    </template>
  </UModal>
  <UModal
    :open="Boolean(categoryDeleteId)"
    title="Delete this category?"
    @update:open="(value: boolean) => { if (!value) categoryDeleteId = null }"
  >
    <template #body>
      <p class="text-sm text-muted">Its channels will become uncategorized.</p>
    </template>
    <template #footer>
      <UButton color="neutral" variant="outline" label="Cancel" @click="categoryDeleteId = null" />
      <UButton color="error" label="Delete category" @click="confirmDeleteCategory" />
    </template>
  </UModal>
</template>
