<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { ChannelCategoryDTO as Category, ChannelDTO as Ch, MemberDTO as M, SidebarThreadDTO } from '~~/shared/types'
import { Permission } from '~~/shared/permissions'
import { channelPath } from '~~/shared/paths'

const props = defineProps<{ serverId: string }>()
const live = useLiveStore()
const { api } = useApi()
const nav = useNavActions()
const warm = useMessagePrefetch()

const membersQ = useQuery({
  queryKey: computed(() => ['members', props.serverId]),
  queryFn: () => api<{ members: M[] }>(`/api/servers/${props.serverId}/members`),
})
const { can } = usePermissions(computed(() => membersQ.data.value?.members))
const channelsQ = useQuery({
  queryKey: computed(() => ['channels', props.serverId]),
  queryFn: () => api<{ categories: Category[]; channels: Ch[]; threads?: SidebarThreadDTO[] }>(`/api/servers/${props.serverId}/channels`),
})

const channels = computed(() => channelsQ.data.value?.channels ?? [])
const categories = computed(() => channelsQ.data.value?.categories ?? [])
const channelGroups = computed(() => {
  const groups = categories.value.map(category => ({
    id: category.id,
    name: category.name,
    channels: channels.value.filter(channel => channel.categoryId === category.id),
  }))
  const uncategorized = channels.value.filter(channel => !channel.categoryId)
  if (uncategorized.length) groups.push({ id: 'uncategorized', name: categories.value.length ? 'Other channels' : 'Channels', channels: uncategorized })
  return groups
})
// The router's live route, so a thread-only URL change (same channel) updates the highlight.
const liveRoute = useRouter().currentRoute
const selected = computed(() => String(liveRoute.value.params.channel || liveRoute.value.params.channelId || ''))
const selectedThread = computed(() => String(liveRoute.value.params.threadId || ''))

// Recently active threads sit under their channel, like Discord.
const threadsByChannel = computed(() => {
  const map = new Map<string, SidebarThreadDTO[]>()
  for (const thread of channelsQ.data.value?.threads ?? []) {
    const list = map.get(thread.parentId) ?? []
    list.push(thread)
    map.set(thread.parentId, list)
  }
  return map
})
function threadsFor(ch: Ch) {
  return threadsByChannel.value.get(ch.id) ?? []
}

function isActive(ch: Ch) {
  if (selectedThread.value && threadsFor(ch).some(thread => thread.id === selectedThread.value)) return false
  const path = channelPath(ch)
  return selected.value === ch.id || liveRoute.value.path === path || liveRoute.value.path.startsWith(`${path}/`)
}

function hasActiveThread(ch: Ch) {
  return Boolean(selectedThread.value) && threadsFor(ch).some(thread => thread.id === selectedThread.value)
}

function participantName(id: string) {
  return membersQ.data.value?.members.find(member => member.user.id === id)?.user.displayName || 'Member'
}

function liveFor(ch: Ch) {
  return live.stateFor(ch.id) ?? ch.live
}

watch(() => channelsQ.data.value?.channels, (list) => {
  if (!list?.length) return
  if (liveRoute.value.path === '/channels') {
    const first = list.find(channel => channel.type === 'text') ?? list[0]
    if (first) void navigateTo(channelPath(first), { replace: true })
  }
}, { immediate: true })
</script>

<template>
  <div>
    <LayoutSkeleton v-if="channelsQ.isPending.value" variant="nav" />
    <LayoutLoadError v-else-if="channelsQ.error.value" inline class="mx-2" message="Channels did not load." :retry="channelsQ.refetch" />
    <template v-else>
      <LayoutNavSection v-if="!channelGroups.length" label="Channels" collapse-key="channels:empty" :create-label="can(Permission.manageChannels) ? 'Create channel' : undefined" @create="nav.openCreateChannel(null)">
        <p class="px-2 py-2 text-sm text-muted">No channels yet.</p>
      </LayoutNavSection>
      <LayoutNavSection
        v-for="(group, index) in channelGroups"
        :key="group.id"
        :label="group.name"
        :collapse-key="`category:${group.id}`"
        :create-label="can(Permission.manageChannels) ? `Create channel in ${group.name}` : undefined"
        :class="index ? 'mt-3' : ''"
        @create="nav.openCreateChannel(group.id === 'uncategorized' ? null : group.id)"
      >
        <ul>
          <li v-for="ch in group.channels" :key="ch.id">
            <LayoutNavRow
              :to="channelPath(ch)"
              :title="ch.name"
              :active="isActive(ch)"
              :ancestor="hasActiveThread(ch)"
              :unread="Boolean(ch.unread)"
              @pointerenter="warm.intent(ch.id)"
              @pointerleave="warm.cancel()"
              @focus="warm.prefetch(ch.id)"
            >
              <template #leading>
                <UIcon name="i-ph-hash" class="size-[18px] shrink-0 text-dimmed" />
              </template>
              {{ ch.name }}
              <template #trailing>
                <UIcon v-if="ch.visibility === 'private'" name="i-ph-lock" class="size-3.5 shrink-0 text-dimmed" />
                <UIcon v-if="liveFor(ch)?.active" name="i-ph-waveform" class="size-3.5 shrink-0 text-success" />
                <UBadge
                  v-if="ch.unread && selected !== ch.id"
                  color="primary"
                  variant="solid"
                  size="sm"
                  :label="ch.unreadCount && ch.unreadCount > 99 ? '99+' : String(ch.unreadCount || '')"
                  :class="ch.unreadCount ? 'min-w-5 justify-center' : 'size-2 rounded-full p-0'"
                />
              </template>
            </LayoutNavRow>
            <LayoutNavThreads :channel="ch" :threads="threadsFor(ch)" :label="ch.name" />
            <ul
              v-if="liveFor(ch)?.active"
              class="space-y-0.5 pb-1 pl-8 pr-1"
            >
              <li
                v-for="id in liveFor(ch)?.participantIds ?? []"
                :key="id"
                class="flex h-7 items-center gap-2 text-sm text-default"
              >
                <UAvatar size="2xs" text="•" />
                <span class="truncate">{{ participantName(id) }}</span>
              </li>
            </ul>
          </li>
        </ul>
      </LayoutNavSection>

    </template>
  </div>
</template>
