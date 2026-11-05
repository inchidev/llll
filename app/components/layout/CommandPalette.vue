<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { onKeyStroke, refDebounced } from '@vueuse/core'
import type { CommandPaletteGroup, CommandPaletteItem } from '@nuxt/ui'
import { isSearchShortcut } from '~~/shared/shortcuts'
import type { GlobalSearchHit } from '~~/shared/global-search'
import type { ChannelDTO } from '~~/shared/types'
import { Permission } from '~~/shared/permissions'
import { channelPath } from '~~/shared/paths'
import { dmTitle } from '~~/shared/dm'

const { open } = useCommandPalette()
const { api } = useApi()
const { serverId } = useServer()
const session = useSessionStore()
const { can, canAnyProject } = useRoleGrants()
const nav = useNavActions()
const ui = useUiStore()
const route = useRoute()
const query = ref('')
const term = refDebounced(query, 200)
onKeyStroke(isSearchShortcut, event => { event.preventDefault(); open.value = !open.value })
watch(open, value => { if (!value) query.value = '' })
watch(() => route.fullPath, () => { open.value = false })
watch(() => session.user?.id, () => { open.value = false })
const search = useQuery({
  queryKey: computed(() => ['global-search', serverId.value, session.user?.id, term.value.trim()]),
  queryFn: ({ signal }) => api<{ hits: GlobalSearchHit[] }>('/api/search', { query: { q: term.value.trim() }, signal }),
  enabled: computed(() => open.value && term.value.trim().length >= 2),
  gcTime: 0, staleTime: 0,
})
const channels = useQuery({
  queryKey: computed(() => ['channels', serverId.value]),
  queryFn: () => api<{ channels: ChannelDTO[] }>(`/api/servers/${serverId.value}/channels`),
  enabled: computed(() => open.value && Boolean(serverId.value)),
})
const dms = useQuery({ queryKey: ['dms'], queryFn: () => api<{ channels: ChannelDTO[] }>('/api/dms'), enabled: open })
function action(label: string, icon: string, run: () => void): CommandPaletteItem {
  return { label, icon, onSelect: () => { open.value = false; ui.mobilePane = 'chat'; run() } }
}
function link(label: string, icon: string, path: string, description?: string): CommandPaletteItem {
  return { ...action(label, icon, () => { void navigateTo(path) }), description }
}
const icons = { item: 'i-ph-file-text', database: 'i-ph-table', task: 'i-ph-check-square', message: 'i-ph-chat-circle' }
const groups = computed<CommandPaletteGroup[]>(() => {
  const navigation = [
    link('Inbox', 'i-ph-tray', '/inbox'), link('Chat', 'i-ph-chats-circle', '/channels'),
    ...(canAnyProject(Permission.readTasks) ? [link('Tasks', 'i-ph-kanban', '/projects/board'), link('My tasks', 'i-ph-user-check', '/projects/my-tasks')] : []),
    ...(can(Permission.readData) ? [link('Data', 'i-ph-stack', '/data')] : []),
    ...(canAnyProject(Permission.readProjects) ? [link('Factory', 'i-ph-git-branch', '/projects')] : []),
    link('Mail', 'i-ph-envelope-simple', '/mail'),
    ...(can(Permission.useAgents) || can(Permission.manageAgents) ? [link('Agents', 'i-ph-robot', '/agents')] : []),
    link('Your settings', 'i-ph-gear', '/settings'),
  ]
  const actions = [
    ...(canAnyProject(Permission.writeTasks) ? [link('Create task', 'i-ph-plus', '/projects/board?create=1')] : []),
    ...(can(Permission.writeData) ? [action('Create page', 'i-ph-file-plus', () => { nav.createDocumentOpen.value = true })] : []),
    ...(route.path.startsWith('/channels/') ? [action('Search this conversation', 'i-ph-magnifying-glass', () => { ui.searchOpen = true })] : []),
    action('Copy link to this page', 'i-ph-link', () => { void copyPageLink() }),
  ]
  const conversations = [
    ...(channels.data.value?.channels ?? []).map(channel => link(channel.name, 'i-ph-hash', channelPath(channel))),
    ...(dms.data.value?.channels ?? []).map(channel => link(channel.title || dmTitle(channel.name, channel.participants ?? [], session.user?.id || ''), 'i-ph-chat-circle', channelPath(channel))),
  ]
  const hits = query.value.trim() === term.value.trim() && query.value.trim().length >= 2 && !search.isFetching.value && !search.error.value ? search.data.value?.hits ?? [] : []
  return [
    { id: 'navigation', label: 'Go to', items: navigation },
    { id: 'actions', label: 'Actions', items: actions },
    { id: 'conversations', label: 'Conversations', items: conversations },
    { id: 'resources', label: 'Tasks and Data', ignoreFilter: true, items: hits.filter(hit => hit.kind !== 'message').map(hit => link(hit.title, icons[hit.kind], hit.path, hit.kind)) },
    { id: 'messages', label: 'Messages', ignoreFilter: true, items: hits.filter(hit => hit.kind === 'message').map(hit => link(hit.title, icons.message, hit.path, hit.description)) },
  ]
})
const toast = useToast()
async function copyPageLink() {
  try { await navigator.clipboard.writeText(window.location.href); toast.add({ title: 'Link copied', color: 'success' }) }
  catch { toast.add({ title: 'The link could not be copied', color: 'error' }) }
}
</script>

<template>
  <UModal v-model:open="open" title="Search and commands" description="Find Tasks, Items, conversations and messages in this Space." :ui="{ content: 'sm:max-w-2xl' }">
    <template #content>
      <label for="command-search" class="sr-only">Search this Space</label>
      <UCommandPalette v-model:search-term="query" :groups="groups" :loading="search.isFetching.value" placeholder="Search or jump to…" :input="{ maxlength: 120, id: 'command-search' }" close @update:open="open = $event" />
      <p v-if="search.error.value && term.trim().length >= 2" role="status" class="border-t border-default px-4 py-3 text-sm text-error">Search could not load. <button type="button" class="underline" @click="search.refetch()">Try again</button></p>
      <p class="border-t border-default px-4 py-2 text-xs text-muted">↑↓ Navigate · Enter Open · Esc Close</p>
    </template>
  </UModal>
</template>
