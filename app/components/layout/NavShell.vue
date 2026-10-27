<script setup lang="ts">
import { navigateTo } from '#imports'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { DropdownMenuItem } from '@nuxt/ui'
import type { ChannelCategoryDTO as Category, ChannelDTO as Ch, MailboxDTO, ServerDTO as W, MemberDTO as M } from '~~/shared/types'
import { Permission } from '~~/shared/permissions'
import { channelPath, mailPath } from '~~/shared/paths'
import { useClipboard } from '@vueuse/core'
import { chatNavigationTarget, hasServerNavigationMenu, serverNavigationSection } from '~~/shared/server-navigation'
import { publicIconPath } from '~~/shared/server-appearance'

const props = defineProps<{ serverId: string }>()
const emit = defineEmits<{ selectSection: [path: string]; selectResource: [navigates: boolean] }>()
const ui = useUiStore()
const route = useRoute()
const qc = useQueryClient()
const toast = useToast()
const session = useSessionStore()
const live = useLiveStore()
const nav = useNavActions()
const { copy } = useClipboard()
const { api, serverUrl } = useApi()

const membersQ = useQuery({
  queryKey: computed(() => ['members', props.serverId]),
  queryFn: () => api<{ members: M[] }>(`/api/servers/${props.serverId}/members`),
})
const { can, canAnyProject } = usePermissions(computed(() => membersQ.data.value?.members))

const serverQ = useQuery({
  queryKey: computed(() => ['server', props.serverId]),
  queryFn: () => api<{ server: W }>(`/api/servers/${props.serverId}`),
  refetchInterval: 60_000,
})
const channelsQ = useQuery({
  queryKey: computed(() => ['channels', props.serverId]),
  queryFn: () => api<{ categories: Category[]; channels: Ch[] }>(`/api/servers/${props.serverId}/channels`),
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

const channels = computed(() => channelsQ.data.value?.channels ?? [])
const categories = computed(() => channelsQ.data.value?.categories ?? [])
const mailboxes = computed(() => mailboxesQ.data.value?.mailboxes ?? [])
const connectedPath = computed(() => {
  const id = live.currentChannelId
  if (!id) return '/channels'
  const conversation = [...channels.value, ...(dmsQ.data.value?.channels ?? [])].find(item => item.id === id)
  return conversation ? channelPath(conversation) : `/channels/${id}`
})

const { unreadConversations } = useInbox(computed(() => props.serverId))
const section = computed(() => serverNavigationSection(route.path))
const hasMenu = computed(() => hasServerNavigationMenu(route.path))
const chatUnread = computed(() => [...channels.value, ...(dmsQ.data.value?.channels ?? [])].some(channel => channel.unread))
const chatTarget = computed(() => {
  const last = ui.last()
  return chatNavigationTarget([...channels.value, ...(dmsQ.data.value?.channels ?? [])], last?.serverId === props.serverId ? last.channelId : undefined)
})
const mailUnread = computed(() => mailboxes.value.some(mailbox => mailbox.unreadCount > 0))
const mailTarget = computed(() => {
  const first = mailboxes.value[0]
  return first ? mailPath(first.channelId) : '/mail'
})
const views = computed(() => [
  { label: 'Inbox', icon: 'i-ph-tray', to: '/inbox', path: '/inbox', count: unreadConversations.value.length, dot: false },
  { label: 'Chat', icon: 'i-ph-chat-circle', to: chatTarget.value, path: '/channels', count: 0, dot: chatUnread.value },
  ...(canAnyProject(Permission.readProjects) ? [{ label: 'Projects', icon: 'i-ph-folder-simple', to: '/projects', path: '/projects', count: 0, dot: false }] : []),
  ...(canAnyProject(Permission.readTasks) ? [{ label: 'Tasks', icon: 'i-ph-kanban', to: '/tasks', path: '/tasks', count: 0, dot: false }] : []),
  ...(can(Permission.manageSchedules) ? [{ label: 'Schedule', icon: 'i-ph-calendar-blank', to: '/schedules', path: '/schedules', count: 0, dot: false }] : []),
  { label: 'Mail', icon: 'i-ph-envelope-simple', to: mailTarget.value, path: '/mail', count: 0, dot: mailUnread.value },
  ...(can(Permission.useAgents) || can(Permission.manageAgents) ? [{ label: 'Agents', icon: 'i-ph-robot', to: '/agents', path: '/agents', count: 0, dot: false }] : []),
  ...(can(Permission.readData) ? [{ label: 'Data', icon: 'i-ph-stack', to: '/data', path: '/data', count: 0, dot: false }] : []),
  ...(can(Permission.useGadgets) || can(Permission.manageGadgets) ? [{ label: 'Apps', icon: 'i-ph-squares-four', to: '/gadgets', path: '/gadgets', count: 0, dot: false }] : []),
])
function isViewActive(path: string) {
  return section.value === serverNavigationSection(path)
}
function selectResource(event: MouseEvent) {
  emit('selectResource', event.target instanceof Element && Boolean(event.target.closest('a[href]')))
}
const menuTitle = computed(() => views.value.find(view => isViewActive(view.path))?.label || '')
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
const serverName = computed(() => serverQ.data.value?.server.name || '')
const serverIconUrl = computed(() => {
  const server = serverQ.data.value?.server
  if (!server?.iconR2Key) return undefined
  return serverUrl(`${publicIconPath}?v=${encodeURIComponent(server.updatedAt)}`)
})
const canOpenServerSettings = computed(() => [
  Permission.useAgents,
  Permission.useExternalTools,
  Permission.manageServer,
  Permission.manageAgents,
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
  if (can(Permission.manageAgents)) manage.push({ label: 'Create Agent', icon: 'i-ph-robot', onSelect: () => { nav.createAgentOpen.value = true } })
  if (canOpenServerSettings.value) {
    manage.push({ label: 'Server settings', icon: 'i-ph-gear', onSelect: () => { nextTick(() => { nav.serverSettingsOpen.value = true }) } })
  }
  return [invite, manage].filter(group => group.length)
})

async function createChannel() {
  if (!newName.value.trim()) return
  creating.value = true
  try {
    const res = await api<{ channel: Ch }>(`/api/servers/${props.serverId}/channels`, {
      method: 'POST',
      body: {
        name: newName.value.trim().toLowerCase().replace(/\s+/g, '-'),
        type: 'text',
        visibility: newPrivate.value ? 'private' : 'server',
        categoryId: nav.createChannelCategoryId.value,
        memberIds: newPrivate.value ? newMemberIds.value : undefined,
      },
    })
    await qc.invalidateQueries({ queryKey: ['channels', props.serverId] })
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
    const res = await api<{ category: Category }>(`/api/servers/${props.serverId}/categories`, {
      method: 'POST',
      body: { name },
    })
    await qc.invalidateQueries({ queryKey: ['channels', props.serverId] })
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
    const res = await api<{ invite: { code: string; url: string } }>(`/api/servers/${props.serverId}/invites`, { method: 'POST', body: {} })
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
  <div class="relative flex h-full min-h-0 w-full select-none flex-col">
    <div class="flex min-h-0 flex-1">
      <div class="flex w-[72px] shrink-0 flex-col border-e border-default bg-muted">
        <UDropdownMenu :items="serverItems" :ui="{ content: 'w-56' }">
          <button
            type="button"
            class="group flex h-12 w-full shrink-0 items-center justify-center focus-visible:outline-2 focus-visible:outline-primary"
            :aria-label="serverName || 'Server menu'"
            :title="serverName || 'Server menu'"
          >
            <span class="server-avatar flex size-11 items-center justify-center rounded-xl transition-colors group-data-[state=open]:bg-accented">
              <UAvatar v-if="serverIconUrl" size="xl" :src="serverIconUrl" :alt="serverName" class="size-10 rounded-lg" />
              <BrandLogo v-else size="xl" alt="" />
            </span>
          </button>
        </UDropdownMenu>

        <nav aria-label="Server views" class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 py-2">
          <div v-if="membersQ.isPending.value" class="space-y-1" aria-label="Loading views" aria-busy="true">
            <div v-for="index in 9" :key="index" class="flex aspect-square w-full flex-col items-center justify-center gap-1.5"><USkeleton class="size-5" /><USkeleton class="h-2 w-10" /></div>
          </div>
          <UButton v-else-if="membersQ.error.value" icon="i-ph-arrow-clockwise" color="neutral" variant="ghost" aria-label="Retry loading views" class="aspect-square w-full justify-center rounded-lg" @click="membersQ.refetch()" />
          <ul v-else class="space-y-1">
            <li v-for="item in views" :key="item.path">
              <NuxtLink
                :to="item.to"
                :title="item.label"
                :aria-current="isViewActive(item.path) ? 'page' : undefined"
                :aria-label="item.count ? `${item.label}, ${item.count} unread conversations` : item.dot ? `${item.label}, unread` : item.label"
                class="relative flex aspect-square w-full flex-col items-center justify-center gap-1 rounded-lg px-0.5 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary"
                :class="isViewActive(item.path) ? 'bg-accented text-highlighted' : 'text-muted hover:bg-elevated hover:text-default'"
                @click="emit('selectSection', item.path)"
              >
                <UIcon :name="item.icon" class="size-[22px] shrink-0" />
                <span class="max-w-full truncate text-[11px] font-medium leading-3">{{ item.label }}</span>
                <span v-if="item.count" class="absolute end-1 top-1 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] leading-4 text-inverted" aria-hidden="true">{{ item.count > 99 ? '99+' : item.count }}</span>
                <span v-else-if="item.dot" class="absolute end-3 top-1.5 size-1.5 rounded-full bg-primary" aria-hidden="true" />
              </NuxtLink>
            </li>
          </ul>
        </nav>
        <button v-if="!hasMenu && live.connection === 'connected' && live.currentChannelId" type="button" class="mx-2 mb-2 flex h-11 items-center justify-center rounded-md text-success hover:bg-elevated" :aria-label="`Return to ${live.currentTitle || 'live conversation'}`" @click="navigateTo(connectedPath)"><UIcon :name="live.currentKind === 'call' ? 'i-ph-phone' : 'i-ph-waveform'" class="size-5" /></button>

      </div>

      <div v-if="hasMenu" class="flex min-h-0 min-w-0 flex-1 flex-col bg-muted" @click.capture="selectResource">
        <header class="flex h-12 shrink-0 items-center gap-2 px-3 shadow-[0_1px_0_var(--ui-border)]">
          <h2 class="min-w-0 flex-1 truncate text-sm font-semibold text-highlighted">{{ menuTitle }}</h2>
          <UButton v-if="section === 'agents' && can(Permission.manageAgents)" icon="i-ph-plus" color="neutral" variant="ghost" square class="size-9 justify-center" aria-label="Create agent" @click="nav.createAgentOpen.value = true" />
          <UButton icon="i-ph-x" color="neutral" variant="ghost" class="size-9 justify-center md:hidden" aria-label="Close navigation" @click="ui.mobilePane = 'chat'" />
        </header>
        <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain py-3">
          <nav v-if="section === 'chat'" aria-label="Conversations" class="space-y-4">
            <LayoutChatNav :server-id="serverId" />
            <LayoutDirectMessages :server-id="serverId" kind="human" />
          </nav>
          <LayoutInboxNav v-else-if="section === 'inbox'" :server-id="serverId" />
          <LayoutAgentsNav v-else-if="section === 'agents'" :server-id="serverId" />
          <LayoutTasksNav v-else-if="section === 'tasks' && canAnyProject(Permission.readTasks)" :server-id="serverId" />
          <LayoutDatabasesNav v-else-if="section === 'data' && can(Permission.readData)" :server-id="serverId" />
          <LayoutGadgetsNav v-else-if="section === 'gadgets' && (can(Permission.useGadgets) || can(Permission.manageGadgets))" :server-id="serverId" />
          <LayoutMailNav v-else-if="section === 'mail'" />
        </div>
        <button
          v-if="live.connection === 'connected' && live.currentChannelId"
          type="button"
          class="pointer-events-auto rounded-lg bg-success/10 px-3 py-2 text-start hover:bg-success/15"
          @click="navigateTo(connectedPath)"
        >
          <p class="flex items-center gap-1.5 text-xs font-semibold text-success"><UIcon :name="live.currentKind === 'call' ? 'i-ph-phone' : 'i-ph-waveform'" class="size-3.5" />Connected</p>
          <p class="truncate text-[11px] text-muted">{{ live.currentTitle || 'Live' }}</p>
        </button>
      </div>
    </div>
    <LayoutUserPanel v-if="!hasMenu" compact />
    <div
      v-if="hasMenu"
      class="pointer-events-none absolute bottom-0 left-0 right-0 z-10 flex flex-col gap-1 px-2 pb-4 pt-8 sm:px-4 sm:pb-6"
    >
      <button
        v-if="live.connection === 'connected' && live.currentChannelId"
        type="button"
        class="pointer-events-auto rounded-lg bg-success/10 px-3 py-2 text-start hover:bg-success/15"
        @click="navigateTo(connectedPath)"
      >
        <p class="flex items-center gap-1.5 text-xs font-semibold text-success"><UIcon :name="live.currentKind === 'call' ? 'i-ph-phone' : 'i-ph-waveform'" class="size-3.5" />Connected</p>
        <p class="truncate text-[11px] text-muted">{{ live.currentTitle || 'Live' }}</p>
      </button>
      <LayoutUserPanel class="pointer-events-auto" />
    </div>
    <SettingsAgentEditorModal v-if="can(Permission.manageAgents)" v-model:open="nav.createAgentOpen.value" :server-id="serverId" />
    <SettingsServerSettings v-if="canOpenServerSettings" v-model:open="nav.serverSettingsOpen.value" v-model:section="nav.serverSettingsSection.value" :server-id="serverId" />

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

<style scoped>
/* The rail's hover language does not paint filled boxes behind avatars, and the
   accent square also matched the avatar's own background. Hover and open states
   morph the avatar radius instead. */
.server-avatar img {
  border-radius: 0.5rem;
  transition: border-radius 150ms ease;
}

.group:hover .server-avatar img,
.group[data-state='open'] .server-avatar img {
  border-radius: 0.25rem;
}
</style>
