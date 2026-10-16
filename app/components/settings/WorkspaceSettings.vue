<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import * as z from 'zod'
import type { FormSubmitEvent, TableColumn } from '@nuxt/ui'
import type { AuditEntryDTO, ChannelCategoryDTO, ChannelDTO, ChannelRoleOverrideDTO, WorkspaceDTO, MemberDTO, RoleDTO } from '~~/shared/types'
import type { UpdateStatusDTO } from '~~/shared/releases'
import { channelPermissionMasks, channelPermissionMode, ChannelPermissionGrants, type ChannelPermissionGrantKey, type ChannelPermissionMode } from '~~/shared/channel-permissions'
import { Permission } from '~~/shared/permissions'
import { formatDateTime } from '~~/shared/format'
import { useClipboard } from '@vueuse/core'


const props = defineProps<{ workspaceId: string }>()
const { serverUrl } = useApi()
const open = defineModel<boolean>('open', { default: false })

const toast = useToast()
const session = useSessionStore()
const qc = useQueryClient()
const { copy } = useClipboard()
/** Exposed so `/w/:id/settings?section=…` can deep-link, and so the section survives reopening. */
const section = defineModel<string>('section', { default: 'overview' })

const schema = z.object({ name: z.string().min(1).max(80) })
type Schema = z.output<typeof schema>
const state = reactive<Partial<Schema>>({ name: '' })
const saving = ref(false)
const permissionChannelId = ref<string | null>(null)
const permissionRoleId = ref<string | null>(null)
const permissionModes = reactive<Record<ChannelPermissionGrantKey, ChannelPermissionMode>>({
  sendMessages: 'inherit',
  attachFiles: 'inherit',
  startLive: 'inherit',
})
const permissionSaving = ref(false)

const workspaceQ = useQuery({
  queryKey: computed(() => ['workspace', props.workspaceId]),
  queryFn: () => $fetch<{ workspace: WorkspaceDTO }>(`/api/workspaces/${props.workspaceId}`),
  enabled: computed(() => Boolean(props.workspaceId) && open.value),
})
const membersQ = useQuery({
  queryKey: computed(() => ['members', props.workspaceId]),
  queryFn: () => $fetch<{ members: MemberDTO[] }>(`/api/workspaces/${props.workspaceId}/members`),
  enabled: computed(() => Boolean(props.workspaceId) && open.value),
})
const { can, mine } = usePermissions(computed(() => membersQ.data.value?.members))
const rolesQ = useQuery({
  queryKey: computed(() => ['roles', props.workspaceId]),
  queryFn: () => $fetch<{ roles: RoleDTO[] }>(`/api/workspaces/${props.workspaceId}/roles`),
  enabled: computed(() => Boolean(props.workspaceId) && open.value && (can(Permission.manageRoles) || can(Permission.manageChannels))),
})
const channelsQ = useQuery({
  queryKey: computed(() => ['channels', props.workspaceId]),
  queryFn: () => $fetch<{ categories: ChannelCategoryDTO[]; channels: ChannelDTO[] }>(`/api/workspaces/${props.workspaceId}/channels`),
  enabled: computed(() => Boolean(props.workspaceId) && open.value),
})
const channelOverridesQ = useQuery({
  queryKey: computed(() => ['channel-role-overrides', permissionChannelId.value]),
  queryFn: () => $fetch<{ overrides: ChannelRoleOverrideDTO[] }>(`/api/channels/${permissionChannelId.value}/role-overrides`),
  enabled: computed(() => Boolean(props.workspaceId) && open.value && section.value === 'channels' && Boolean(permissionChannelId.value)),
})
const invitesQ = useQuery({
  queryKey: computed(() => ['invites', props.workspaceId]),
  queryFn: () => $fetch<{ invites: Array<{ code: string; url: string; maxUses: number; uses: number; expiresAt: string | null; createdAt: string }> }>(`/api/workspaces/${props.workspaceId}/invites`),
  enabled: computed(() => Boolean(props.workspaceId) && open.value && section.value === 'invites'),
})
const auditQ = useQuery({
  queryKey: computed(() => ['audit', props.workspaceId]),
  queryFn: () => $fetch<{ entries: AuditEntryDTO[] }>(`/api/workspaces/${props.workspaceId}/audit`),
  enabled: computed(() => Boolean(props.workspaceId) && open.value && section.value === 'audit'),
})
const isOwner = computed(() => mine.value?.role.key === 'owner')
const updatesQ = useQuery({
  queryKey: computed(() => ['updates', props.workspaceId]),
  queryFn: () => $fetch<UpdateStatusDTO>(`/api/workspaces/${props.workspaceId}/updates`),
  enabled: computed(() => Boolean(props.workspaceId) && open.value && isOwner.value),
  staleTime: 6 * 60 * 60 * 1000,
})

watch(() => workspaceQ.data.value?.workspace.name, (n) => { if (n) state.name = n }, { immediate: true })

const workspaceNav = computed(() => [
  ...(can(Permission.manageWorkspace) ? [{ id: 'overview' as const, label: 'Overview', icon: 'i-ph-house', keywords: ['name', 'icon', 'rename'] }] : []),
  ...(can(Permission.manageChannels) ? [{ id: 'channels' as const, label: 'Channels', icon: 'i-ph-hash', keywords: ['categories', 'private'] }] : []),
  ...(can(Permission.manageRoles) ? [{ id: 'roles' as const, label: 'Roles', icon: 'i-ph-shield', keywords: ['permissions', 'admin', 'access'] }] : []),
  ...(can(Permission.manageRoles) || can(Permission.kick) ? [{ id: 'members' as const, label: 'Members', icon: 'i-ph-users', keywords: ['people', 'kick', 'assign role'] }] : []),
  ...(can(Permission.invite) && session.health?.authMode !== 'access' ? [{ id: 'invites' as const, label: 'Invites', icon: 'i-ph-user-plus', keywords: ['invite link', 'join', 'share'] }] : []),
])
const featureNav = computed(() => [
  ...(can(Permission.manageWorkspace) ? [{ id: 'agents' as const, label: 'Agents', icon: 'i-ph-robot', keywords: ['bots', 'automation', 'tasks'] }] : []),
  ...(isOwner.value ? [{ id: 'live' as const, label: 'Live', icon: 'i-ph-waveform', keywords: ['calls', 'video', 'audio', 'screen share', 'realtimekit'] }] : []),
  ...(can(Permission.manageWorkspace) ? [{ id: 'email' as const, label: 'Email', icon: 'i-ph-envelope-simple', keywords: ['mail', 'mailbox', 'inbox', 'domain'] }] : []),
  ...(isOwner.value ? [{ id: 'mcp' as const, label: 'MCP', icon: 'i-ph-plugs-connected', keywords: ['agent', 'access token', 'api', 'codex'] }] : []),
])
const accessNav = computed(() => [
  ...(isOwner.value ? [{ id: 'authentication' as const, label: 'Authentication', icon: 'i-ph-key', keywords: ['login', 'signup', 'oauth', 'github', 'sso', 'registration'] }] : []),
  ...(isOwner.value ? [{ id: 'onboarding' as const, label: 'Onboarding', icon: 'i-ph-flag-banner', keywords: ['welcome', 'first run', 'branding'] }] : []),
  ...(can(Permission.manageWorkspace) ? [{ id: 'audit' as const, label: 'Audit Log', icon: 'i-ph-list-magnifying-glass', keywords: ['history', 'activity', 'log'] }] : []),
])
const installationSections = ['cloudflare', 'domains', 'backups', 'updates', 'telemetry', 'danger']
const installationNav = computed(() => isOwner.value
  ? [{
      id: 'cloudflare' as const,
      label: 'System',
      icon: 'i-ph-hard-drives',
      aliases: installationSections,
      badge: updatesQ.data.value?.updateAvailable ? String(updatesQ.data.value.releasesBehind) : undefined,
      keywords: [
        'cloudflare', 'installation', 'management', 'instance token', 'managed', 'manual', 'deployment',
        'domain', 'app domain', 'custom domain', 'address', 'url', 'dns', 'zone',
        'backup', 'download', 'export', 'restore', 'd1', 'r2',
        'updates', 'release', 'version', 'upgrade', 'github',
        'telemetry', 'anonymous', 'heartbeat', 'privacy', 'stats',
        'danger', 'delete workspace', 'delete server', 'remove', 'destroy', 'uninstall',
      ],
    }]
  : [])
const groups = computed(() => [
  { label: 'Workspace', items: workspaceNav.value },
  { label: 'Features', items: featureNav.value },
  { label: 'Access', items: accessNav.value },
  { items: installationNav.value },
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
const workspaceIconInput = ref<HTMLInputElement | null>(null)
const workspaceIconBusy = ref(false)
const createCategoryOpen = ref(false)
const newCategoryName = ref('')
const categoryCreating = ref(false)
const selectedCategoryId = ref<string | null>(null)
const categoryName = ref('')
const categorySaving = ref(false)
const categoryDeleteId = ref<string | null>(null)
const channelAssigningId = ref<string | null>(null)

const roles = computed(() => rolesQ.data.value?.roles ?? [])
const categories = computed(() => channelsQ.data.value?.categories ?? [])
const workspaceChannels = computed(() => (channelsQ.data.value?.channels ?? []).filter(channel => channel.type !== 'dm' && channel.type !== 'thread'))
const selectedCategory = computed(() => categories.value.find(category => category.id === selectedCategoryId.value) ?? null)
const categoryOptions = computed(() => [
  { label: 'Uncategorized', value: 'uncategorized' },
  ...categories.value.map(category => ({ label: category.name, value: category.id })),
])
const roleOptions = computed(() => roles.value
  .filter(role => role.key !== 'owner' && (role.key !== 'admin' || isOwner.value))
  .map(role => ({ label: roleLabel(role.name), value: role.id })))
const permissionChannel = computed(() => workspaceChannels.value.find(channel => channel.id === permissionChannelId.value) ?? null)
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

watch([workspaceChannels, section], ([list, activeSection]) => {
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
const channelCount = computed(() => workspaceChannels.value.length)
const workspaceName = computed(() => workspaceQ.data.value?.workspace.name || 'Workspace')
const workspaceInitial = computed(() => workspaceName.value.slice(0, 1).toUpperCase())
const workspaceIconUrl = computed(() => {
  const workspace = workspaceQ.data.value?.workspace
  if (!workspace?.iconR2Key) return undefined
  return serverUrl(`/api/workspaces/${props.workspaceId}/icon?v=${encodeURIComponent(workspace.updatedAt)}`)
})

async function onSave(event: FormSubmitEvent<Schema>) {
  saving.value = true
  try {
    await $fetch(`/api/workspaces/${props.workspaceId}`, { method: 'PATCH', body: event.data })
    await qc.invalidateQueries({ queryKey: ['workspace', props.workspaceId] })
    toast.add({ title: 'Workspace updated', color: 'success' })
  }
  catch (err) {
    toast.add({ title: errorMessage(err), color: 'error' })
  }
  finally {
    saving.value = false
  }
}

async function uploadWorkspaceIcon(event: Event) {
  if (session.health?.bindings.r2 === false) return
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  workspaceIconBusy.value = true
  try {
    const body = new FormData()
    body.append('file', file)
    await $fetch(`/api/workspaces/${props.workspaceId}/icon`, { method: 'PUT', body })
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['workspace', props.workspaceId] }),
      qc.invalidateQueries({ queryKey: ['workspaces'] }),
    ])
    toast.add({ title: 'Workspace icon updated', color: 'success' })
  }
  catch (err) {
    toast.add({ title: errorMessage(err), color: 'error' })
  }
  finally {
    workspaceIconBusy.value = false
    input.value = ''
  }
}

async function removeWorkspaceIcon() {
  workspaceIconBusy.value = true
  try {
    await $fetch(`/api/workspaces/${props.workspaceId}/icon`, { method: 'DELETE' })
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['workspace', props.workspaceId] }),
      qc.invalidateQueries({ queryKey: ['workspaces'] }),
    ])
    toast.add({ title: 'Workspace icon removed', color: 'success' })
  }
  catch (err) {
    toast.add({ title: errorMessage(err), color: 'error' })
  }
  finally {
    workspaceIconBusy.value = false
  }
}

async function createCategory() {
  const name = newCategoryName.value.trim()
  if (!name) return
  categoryCreating.value = true
  try {
    const result = await $fetch<{ category: ChannelCategoryDTO }>(`/api/workspaces/${props.workspaceId}/categories`, {
      method: 'POST',
      body: { name },
    })
    await qc.invalidateQueries({ queryKey: ['channels', props.workspaceId] })
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
    await $fetch(`/api/workspaces/${props.workspaceId}/categories/${category.id}`, {
      method: 'PATCH',
      body: { name },
    })
    await qc.invalidateQueries({ queryKey: ['channels', props.workspaceId] })
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
    await $fetch(`/api/workspaces/${props.workspaceId}/categories/${categoryId}`, { method: 'DELETE' })
    categoryDeleteId.value = null
    selectedCategoryId.value = null
    await qc.invalidateQueries({ queryKey: ['channels', props.workspaceId] })
    toast.add({ title: 'Category deleted', color: 'success' })
  }
  catch (err) {
    toast.add({ title: errorMessage(err), color: 'error' })
  }
}

async function assignChannelCategory(channelId: string, categoryId: string) {
  channelAssigningId.value = channelId
  try {
    await $fetch(`/api/channels/${channelId}`, {
      method: 'PATCH',
      body: { categoryId: categoryId === 'uncategorized' ? null : categoryId },
    })
    await qc.invalidateQueries({ queryKey: ['channels', props.workspaceId] })
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
    await $fetch(`/api/channels/${permissionChannelId.value}/role-overrides/${permissionRoleId.value}`, {
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
    await $fetch(`/api/channels/${permissionChannelId.value}/role-overrides/${permissionRoleId.value}`, { method: 'DELETE' })
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
    const res = await $fetch<{ invite: { url: string } }>(`/api/workspaces/${props.workspaceId}/invites`, { method: 'POST', body: {} })
    inviteUrl.value = serverUrl(res.invite.url)
    await qc.invalidateQueries({ queryKey: ['invites', props.workspaceId] })
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
  await $fetch(`/api/workspaces/${props.workspaceId}/members/${kickId.value}`, { method: 'DELETE' })
  await qc.invalidateQueries({ queryKey: ['members', props.workspaceId] })
  kickId.value = null
  toast.add({ title: 'Member kicked', color: 'success' })
}

async function assignRole(userId: string, roleId: string) {
  assigningId.value = userId
  try {
    await $fetch(`/api/workspaces/${props.workspaceId}/members/${userId}`, { method: 'PATCH', body: { roleId } })
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['members', props.workspaceId] }),
      qc.invalidateQueries({ queryKey: ['roles', props.workspaceId] }),
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
  <SettingsOverlay v-model:open="open" v-model:section="section" :groups="groups" :title="workspaceName" :loading="membersQ.isPending.value">
    <template v-if="section === 'overview'">
      <h1 class="text-xl font-semibold text-highlighted">Workspace Overview</h1>
      <div class="mt-8 flex items-start gap-6">
        <div class="flex shrink-0 flex-col items-center gap-2">
          <UAvatar size="3xl" :src="workspaceIconUrl" :text="workspaceInitial" :alt="workspaceName" />
          <input
            ref="workspaceIconInput"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            class="hidden"
            @change="uploadWorkspaceIcon"
          >
          <div v-if="can(Permission.manageWorkspace)" class="flex items-center gap-1">
            <UButton
              size="xs"
              color="neutral"
              variant="soft"
              label="Change icon"
              :disabled="session.health?.bindings.r2 === false"
              :loading="workspaceIconBusy"
              @click="workspaceIconInput?.click()"
            />
            <UTooltip v-if="workspaceQ.data.value?.workspace.iconR2Key" text="Remove icon">
              <UButton
                size="xs"
                color="error"
                variant="ghost"
                icon="i-ph-trash"
                aria-label="Remove workspace icon"
                :disabled="workspaceIconBusy"
                @click="removeWorkspaceIcon"
              />
            </UTooltip>
          </div>
        </div>
        <UForm :schema="schema" :state="state" class="flex-1 max-w-md space-y-4" @submit="onSave">
          <UFormField name="name" label="Workspace Name">
            <UInput v-model="state.name" class="w-full" :disabled="!can(Permission.manageWorkspace)" />
          </UFormField>
          <UButton v-if="can(Permission.manageWorkspace)" type="submit" label="Save Changes" :loading="saving" />
        </UForm>
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
      <div class="mt-6 grid gap-6 lg:grid-cols-[210px_minmax(0,1fr)]">
        <div class="space-y-1">
          <button
            v-for="category in categories"
            :key="category.id"
            type="button"
            class="w-full rounded-md px-3 py-2 text-start hover:bg-elevated"
            :class="selectedCategoryId === category.id ? 'bg-accented text-highlighted' : 'text-muted'"
            @click="selectedCategoryId = category.id"
          >
            <span class="block truncate text-sm font-medium">{{ category.name }}</span>
            <span class="block text-xs text-muted">
              {{ workspaceChannels.filter(channel => channel.categoryId === category.id).length }} channels
            </span>
          </button>
          <p v-if="!categories.length" class="px-3 py-2 text-sm text-muted">No categories</p>
        </div>
        <div v-if="selectedCategory" class="min-w-0">
          <UFormField label="Category name">
            <UInput
              v-model="categoryName"
              class="w-full"
              :disabled="!can(Permission.manageChannels)"
              @keyup.enter="saveCategory"
            />
          </UFormField>
          <div v-if="can(Permission.manageChannels)" class="mt-4 flex items-center justify-between gap-3">
            <UButton color="error" variant="ghost" label="Delete category" @click="categoryDeleteId = selectedCategory.id" />
            <UButton label="Save changes" :loading="categorySaving" :disabled="!categoryName.trim()" @click="saveCategory" />
          </div>
        </div>
      </div>
      <h2 class="mt-10 text-sm font-semibold text-highlighted">Channels</h2>
      <ul class="mt-2 divide-y divide-default">
        <li v-for="channel in workspaceChannels" :key="channel.id" class="flex items-center gap-3 py-3">
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
          <USelect
            :model-value="channel.categoryId || 'uncategorized'"
            :items="categoryOptions"
            value-key="value"
            label-key="label"
            size="sm"
            class="w-48"
            :disabled="!can(Permission.manageChannels)"
            :loading="channelAssigningId === channel.id"
            :aria-label="`Category for ${channel.name}`"
            @update:model-value="assignChannelCategory(channel.id, String($event))"
          />
        </li>
      </ul>
      <div v-if="permissionChannel" class="mt-6 rounded-lg border border-default p-4">
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
      </div>
    </template>

    <template v-else-if="section === 'roles'">
      <SettingsRolesSettings :workspace-id="workspaceId" />
    </template>

    <template v-else-if="section === 'agents'">
      <SettingsAgentSettings :workspace-id="workspaceId" />
    </template>

    <template v-else-if="section === 'members'">
      <h1 class="text-xl font-semibold text-highlighted">Members</h1>
      <p class="mt-1 text-sm text-muted">{{ memberCount }} {{ memberCount === 1 ? 'member' : 'members' }} in this workspace.</p>
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
      <p class="mt-1 text-sm text-muted">Anyone with a link can join this workspace.</p>
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

    <template v-else-if="section === 'live'">
      <SettingsRealtimeKitSettings :workspace-id="workspaceId" />
    </template>

    <template v-else-if="section === 'email'">
      <SettingsEmailSettings :workspace-id="workspaceId" />
    </template>

    <template v-else-if="section === 'authentication'">
      <SettingsAuthSettings :workspace-id="workspaceId" />
    </template>

    <template v-else-if="section === 'onboarding'">
      <SettingsOnboardingSettings :workspace-id="workspaceId" />
    </template>

    <template v-else-if="section === 'mcp'">
      <SettingsMcpSettings :workspace-id="workspaceId" />
    </template>

    <template v-else-if="installationSections.includes(section)">
      <SettingsInstallationSettings
        v-model:section="section"
        :workspace-id="workspaceId"
        :workspace-name="workspaceName"
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
