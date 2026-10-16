<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { DropdownMenuItem } from '@nuxt/ui'
import type { ChannelCategoryDTO as Category, ChannelDTO as Ch, MailboxDTO, WorkspaceDTO as W, MemberDTO as M } from '~~/shared/types'
import { Permission } from '~~/shared/permissions'
import { channelPath, mailPath } from '~~/shared/paths'
import { useClipboard } from '@vueuse/core'

type Mode = 'chat' | 'tasks' | 'mail' | 'databases' | 'gadgets'

const props = defineProps<{ workspaceId: string }>()
const route = useRoute()
const qc = useQueryClient()
const toast = useToast()
const ui = useUiStore()
const session = useSessionStore()
const live = useLiveStore()
const nav = useNavActions()
const { copy } = useClipboard()
const { api, serverUrl } = useApi()

const membersQ = useQuery({
  queryKey: computed(() => ['members', props.workspaceId]),
  queryFn: () => api<{ members: M[] }>(`/api/workspaces/${props.workspaceId}/members`),
})
const { can } = usePermissions(computed(() => membersQ.data.value?.members))

const workspaceQ = useQuery({
  queryKey: computed(() => ['workspace', props.workspaceId]),
  queryFn: () => api<{ workspace: W }>(`/api/workspaces/${props.workspaceId}`),
})
const channelsQ = useQuery({
  queryKey: computed(() => ['channels', props.workspaceId]),
  queryFn: () => api<{ categories: Category[]; channels: Ch[] }>(`/api/workspaces/${props.workspaceId}/channels`),
})
const dmsQ = useQuery({
  queryKey: ['dms'],
  queryFn: () => api<{ channels: Ch[] }>('/api/dms'),
})
const mailboxesQ = useQuery({
  queryKey: ['mailboxes'],
  queryFn: () => api<{ mailboxes: MailboxDTO[] }>('/api/mail/mailboxes'),
  refetchInterval: 15_000,
})
const workspacesQ = useQuery({
  queryKey: ['workspaces'],
  queryFn: () => api<{ workspaces: W[] }>('/api/workspaces'),
})

const channels = computed(() => channelsQ.data.value?.channels ?? [])
const categories = computed(() => channelsQ.data.value?.categories ?? [])
const mailboxes = computed(() => mailboxesQ.data.value?.mailboxes ?? [])
const connectedPath = computed(() => {
  const id = live.currentChannelId
  if (!id) return '/channels'
  const conversation = [...channels.value, ...(dmsQ.data.value?.channels ?? [])].find(item => item.id === id)
  return conversation ? channelPath(conversation) : `/channels/${id}`
})

/** The mode is read off the route, so a deep link lands in the right one. */
const mode = computed<Mode>(() => {
  if (route.path.startsWith('/tasks')) return 'tasks'
  if (route.path.startsWith('/mail')) return 'mail'
  if (route.path.startsWith('/databases')) return 'databases'
  if (route.path.startsWith('/documents')) return 'databases'
  if (route.path.startsWith('/canvases')) return 'databases'
  if (route.path.startsWith('/gadgets')) return 'gadgets'
  return 'chat'
})

const chatUnread = computed(() => [...channels.value, ...(dmsQ.data.value?.channels ?? [])].some(channel => channel.unread))
const mailUnread = computed(() => mailboxes.value.some(mailbox => mailbox.unreadCount > 0))

const chatTarget = computed(() => {
  const last = ui.last()
  return last?.workspaceId === props.workspaceId ? channelPath(last.channelId) : '/channels'
})

const mailTarget = computed(() => {
  const first = mailboxes.value[0]
  return first ? mailPath(first.channelId) : '/mail'
})

const modes = computed(() => [
  { value: 'chat' as const, label: 'Chat', icon: 'i-ph-chat-circle', to: chatTarget.value, dot: chatUnread.value },
  ...(can(Permission.manageTasks) ? [{ value: 'tasks' as const, label: 'Tasks', icon: 'i-ph-kanban', to: '/tasks', dot: false }] : []),
  { value: 'mail' as const, label: 'Mail', icon: 'i-ph-envelope-simple', to: mailTarget.value, dot: mailUnread.value },
  ...(can(Permission.manageDatabases) ? [{ value: 'databases' as const, label: 'Data', icon: 'i-ph-table', to: '/databases', dot: false }] : []),
  ...(can(Permission.useGadgets) || can(Permission.manageGadgets) ? [{ value: 'gadgets' as const, label: 'Apps', icon: 'i-ph-squares-four', to: '/gadgets', dot: false }] : []),
])

function leaveLiveOnPageExit() {
  if (!live.currentChannelId || live.connection !== 'connected') return
  navigator.sendBeacon?.(`/api/channels/${live.currentChannelId}/live/leave`)
}

watch(() => live.notice, (message) => {
  if (!message) return
  toast.add({ title: message, icon: live.currentKind === 'call' ? 'i-ph-phone-disconnect' : 'i-ph-waveform' })
  live.notice = null
})

onMounted(() => {
  window.addEventListener('pagehide', leaveLiveOnPageExit)
})

onBeforeUnmount(() => {
  window.removeEventListener('pagehide', leaveLiveOnPageExit)
})

const newName = ref('')
const newPrivate = ref(false)
const newMemberIds = ref<string[]>([])
const newCategoryName = ref('')
const inviteUrl = ref('')
const inviting = ref(false)
const creating = ref(false)
const creatingCategory = ref(false)

const categoryOptions = computed(() => [
  { label: 'Uncategorized', value: null },
  ...categories.value.map(category => ({ label: category.name, value: category.id })),
])
const workspaceName = computed(() => workspaceQ.data.value?.workspace.name || '')
const workspaceIconUrl = computed(() => {
  const workspace = workspaceQ.data.value?.workspace
  if (!workspace?.iconR2Key) return undefined
  return serverUrl(`/api/workspaces/${props.workspaceId}/icon?v=${encodeURIComponent(workspace.updatedAt)}`)
})
const otherWorkspaces = computed(() => (workspacesQ.data.value?.workspaces ?? []).filter(item => item.id !== props.workspaceId))
const canOpenWorkspaceSettings = computed(() => [
  Permission.manageWorkspace,
  Permission.manageChannels,
  Permission.manageRoles,
  Permission.invite,
  Permission.kick,
].some(flag => can(flag)))

const serverItems = computed<DropdownMenuItem[][]>(() => {
  const invite: DropdownMenuItem[] = can(Permission.invite) && session.health?.authMode !== 'access'
    ? [{ label: 'Invite People', icon: 'i-ph-user-plus', color: 'primary', onSelect: () => { nav.inviteOpen.value = true } }]
    : []
  const manage: DropdownMenuItem[] = []
  if (can(Permission.manageChannels)) {
    manage.push(
      { label: 'Create Channel', icon: 'i-ph-hash', onSelect: () => { nav.openCreateChannel(categories.value[0]?.id ?? null) } },
      { label: 'Create Category', icon: 'i-ph-folder-plus', onSelect: () => { nav.createCategoryOpen.value = true } },
    )
  }
  if (canOpenWorkspaceSettings.value) {
    manage.push({ label: 'Workspace Settings', icon: 'i-ph-gear', onSelect: () => { nextTick(() => { nav.workspaceSettingsOpen.value = true }) } })
  }
  const switcher: DropdownMenuItem[] = otherWorkspaces.value.map(item => ({
    label: item.name,
    icon: 'i-ph-hard-drives',
    to: '/channels',
  }))
  return [invite, manage, switcher].filter(group => group.length)
})

async function createChannel() {
  if (!newName.value.trim()) return
  creating.value = true
  try {
    const res = await api<{ channel: Ch }>(`/api/workspaces/${props.workspaceId}/channels`, {
      method: 'POST',
      body: {
        name: newName.value.trim().toLowerCase().replace(/\s+/g, '-'),
        type: 'text',
        visibility: newPrivate.value ? 'private' : 'workspace',
        categoryId: nav.createChannelCategoryId.value,
        memberIds: newPrivate.value ? newMemberIds.value : undefined,
      },
    })
    await qc.invalidateQueries({ queryKey: ['channels', props.workspaceId] })
    nav.createChannelOpen.value = false
    newName.value = ''
    newPrivate.value = false
    newMemberIds.value = []
    await navigateTo(channelPath(res.channel))
  }
  finally {
    creating.value = false
  }
}

async function createCategory() {
  const name = newCategoryName.value.trim()
  if (!name) return
  creatingCategory.value = true
  try {
    const res = await api<{ category: Category }>(`/api/workspaces/${props.workspaceId}/categories`, {
      method: 'POST',
      body: { name },
    })
    await qc.invalidateQueries({ queryKey: ['channels', props.workspaceId] })
    newCategoryName.value = ''
    nav.createCategoryOpen.value = false
    nav.openCreateChannel(res.category.id)
  }
  finally {
    creatingCategory.value = false
  }
}

async function makeInvite() {
  inviting.value = true
  try {
    const res = await api<{ invite: { code: string; url: string } }>(`/api/workspaces/${props.workspaceId}/invites`, { method: 'POST', body: {} })
    inviteUrl.value = serverUrl(res.invite.url)
  }
  catch (err) {
    toast.add({ title: errorMessage(err), color: 'error' })
    nav.inviteOpen.value = false
  }
  finally {
    inviting.value = false
  }
}

async function copyInvite() {
  if (!inviteUrl.value) return
  await copy(inviteUrl.value)
  toast.add({ title: 'Invite copied', color: 'success' })
}

watch(nav.inviteOpen, (open) => {
  if (open) {
    inviteUrl.value = ''
    void makeInvite()
  }
})
</script>

<template>
  <div class="flex h-full min-h-0 select-none flex-col">
    <UDropdownMenu :items="serverItems" :ui="{ content: 'w-56' }">
      <button
        type="button"
        class="flex h-12 w-full shrink-0 items-center gap-1.5 px-3 shadow-[0_1px_0_var(--ui-border)] hover:bg-elevated/70"
        :aria-label="workspaceName || 'Workspace menu'"
      >
        <UAvatar v-if="workspaceIconUrl" size="sm" :src="workspaceIconUrl" :alt="workspaceName" class="rounded-md" />
        <BrandLogo v-else size="lg" :alt="workspaceName" class="rounded-md" />
        <span v-if="workspaceName" class="min-w-0 flex-1 truncate text-start text-sm font-semibold text-highlighted">{{ workspaceName }}</span>
        <span v-else class="min-w-0 flex-1"><USkeleton class="h-3.5 w-24" /></span>
        <UIcon name="i-ph-caret-down" class="size-4 shrink-0 text-muted" />
      </button>
    </UDropdownMenu>

    <nav
      class="m-2 grid shrink-0 grid-flow-col auto-cols-fr gap-0.5 rounded-lg bg-elevated/60 p-0.5"
      aria-label="App"
    >
      <!-- Which apps show depends on permissions; hold their place until they are known. -->
      <template v-if="membersQ.isPending.value">
        <div v-for="index in 5" :key="index" class="flex h-[46px] flex-col items-center justify-center gap-1.5 rounded-md">
          <USkeleton class="size-[18px] rounded bg-accented" />
          <USkeleton class="h-2 w-7 bg-accented" />
        </div>
      </template>
      <template v-else>
        <NuxtLink
          v-for="item in modes"
          :key="item.value"
          :to="item.to"
          class="relative flex flex-col items-center gap-0.5 rounded-md py-1.5 text-[11px]"
          :class="mode === item.value ? 'bg-default text-highlighted shadow-sm' : 'text-muted hover:text-default'"
          :aria-current="mode === item.value ? 'page' : undefined"
        >
          <UIcon :name="item.icon" class="size-[18px]" />
          <span>{{ item.label }}</span>
          <span
            v-if="item.dot && mode !== item.value"
            class="absolute end-[calc(50%-15px)] top-1 size-1.5 rounded-full bg-primary"
            aria-hidden="true"
          />
        </NuxtLink>
      </template>
    </nav>

    <div class="flex-1 overflow-y-auto pb-2">
      <LayoutChatNav v-if="mode === 'chat'" :workspace-id="workspaceId" />
      <LayoutTasksNav v-else-if="mode === 'tasks'" :workspace-id="workspaceId" />
      <LayoutDatabasesNav v-else-if="mode === 'databases'" :workspace-id="workspaceId" />
      <LayoutGadgetsNav v-else-if="mode === 'gadgets'" :workspace-id="workspaceId" />
      <LayoutMailNav v-else />
    </div>

    <button
      v-if="live.connection === 'connected' && live.currentChannelId"
      type="button"
      class="mx-2 mb-0 rounded-lg bg-success/10 px-3 py-2 text-start hover:bg-success/15"
      @click="navigateTo(connectedPath)"
    >
      <p class="flex items-center gap-1.5 text-xs font-semibold text-success">
        <UIcon :name="live.currentKind === 'call' ? 'i-ph-phone' : 'i-ph-waveform'" class="size-3.5" />
        Connected
      </p>
      <p class="truncate text-[11px] text-muted">{{ live.currentTitle || 'Live' }}</p>
    </button>
    <LayoutUserPanel />
    <SettingsWorkspaceSettings v-if="canOpenWorkspaceSettings" v-model:open="nav.workspaceSettingsOpen.value" v-model:section="nav.workspaceSettingsSection.value" :workspace-id="workspaceId" />

    <UModal v-model:open="nav.createChannelOpen.value" title="Create Channel">
      <template #body>
        <div class="space-y-4">
          <UFormField label="Channel name" class="w-full">
            <UInput v-model="newName" placeholder="new-channel" autofocus class="w-full" @keyup.enter="createChannel" />
          </UFormField>
          <UFormField label="Category">
            <USelect v-model="nav.createChannelCategoryId.value" :items="categoryOptions" class="w-full" />
          </UFormField>
          <UCheckbox v-model="newPrivate" label="Private channel" />
          <UFormField v-if="newPrivate" label="Members">
            <div class="max-h-40 space-y-2 overflow-y-auto rounded-md border border-default p-3">
              <UCheckbox
                v-for="member in membersQ.data.value?.members ?? []"
                :key="member.user.id"
                :model-value="newMemberIds.includes(member.user.id)"
                :label="member.nickname || member.user.displayName"
                @update:model-value="(checked) => newMemberIds = checked
                  ? [...new Set([...newMemberIds, member.user.id])]
                  : newMemberIds.filter((id) => id !== member.user.id)"
              />
            </div>
          </UFormField>
        </div>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" label="Cancel" @click="nav.createChannelOpen.value = false" />
        <UButton label="Create Channel" :loading="creating" :disabled="!newName.trim()" @click="createChannel" />
      </template>
    </UModal>

    <UModal v-model:open="nav.createCategoryOpen.value" title="Create Category">
      <template #body>
        <UFormField label="Category name" class="w-full">
          <UInput v-model="newCategoryName" placeholder="Category" autofocus class="w-full" @keyup.enter="createCategory" />
        </UFormField>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" label="Cancel" @click="nav.createCategoryOpen.value = false" />
        <UButton label="Create Category" :loading="creatingCategory" :disabled="!newCategoryName.trim()" @click="createCategory" />
      </template>
    </UModal>

    <UModal v-model:open="nav.inviteOpen.value" title="Invite people" description="Share this link. Anyone with it can join.">
      <template #body>
        <USkeleton v-if="inviting" class="h-9" />
        <UInput v-else v-model="inviteUrl" readonly class="w-full">
          <template #trailing>
            <UButton size="xs" label="Copy" @click="copyInvite" />
          </template>
        </UInput>
      </template>
    </UModal>
    <LiveIncomingCall />
  </div>
</template>
