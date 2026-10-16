<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { ChannelDTO, PublicUser } from '~~/shared/types'
import { channelPath } from '~~/shared/paths'
import { dmTitle } from '~~/shared/dm'

type DmSearchMember = PublicUser & {
  handle: string | null
  nickname: string | null
}

const props = defineProps<{ workspaceId: string }>()
const route = useRoute()
const session = useSessionStore()
const qc = useQueryClient()
const live = useLiveStore()
const { api } = useApi()
const warm = useMessagePrefetch()

const dmsQ = useQuery({
  queryKey: ['dms'],
  queryFn: () => api<{ channels: ChannelDTO[] }>('/api/dms'),
})

const q = ref('')
const picker = ref(false)
const picked = ref<string[]>([])
const searchQ = useQuery({
  queryKey: computed(() => ['dm-search', props.workspaceId, q.value]),
  queryFn: () => api<{ members: DmSearchMember[] }>(`/api/dms/search?workspaceId=${props.workspaceId}&q=${encodeURIComponent(q.value)}`),
  enabled: computed(() => picker.value),
})

const selected = computed(() => String(route.params.channel || route.params.channelId || ''))
const collapsed = ref(false)

function initials(ch: ChannelDTO) {
  const others = (ch.participants ?? []).filter((p) => p.id !== session.user?.id)
  if (others.length === 0) return '?'
  return others.slice(0, 2).map((p) => p.displayName.slice(0, 1).toUpperCase()).join('')
}

function avatarUser(ch: ChannelDTO) {
  const others = (ch.participants ?? []).filter(p => p.id !== session.user?.id)
  return others.length === 1 ? others[0] : null
}

function togglePick(id: string) {
  picked.value = picked.value.includes(id) ? picked.value.filter((x) => x !== id) : [...picked.value, id]
}

async function openDm(userId: string) {
  const res = await api<{ channel: ChannelDTO }>('/api/dms', { method: 'POST', body: { userId, workspaceId: props.workspaceId } })
  await qc.invalidateQueries({ queryKey: ['dms'] })
  picker.value = false
  q.value = ''
  picked.value = []
  await navigateTo(channelPath(res.channel))
}

async function startGroup() {
  if (picked.value.length < 2) return
  const res = await api<{ channel: ChannelDTO }>('/api/dms/group', {
    method: 'POST',
    body: { userIds: picked.value, workspaceId: props.workspaceId },
  })
  await qc.invalidateQueries({ queryKey: ['dms'] })
  picker.value = false
  q.value = ''
  picked.value = []
  await navigateTo(channelPath(res.channel))
}

async function hide(id: string) {
  await api(`/api/dms/${id}/hide`, { method: 'POST' })
  await qc.invalidateQueries({ queryKey: ['dms'] })
  if (selected.value === id) await navigateTo('/channels')
}

function inCall(ch: ChannelDTO) {
  return Boolean((live.stateFor(ch.id) ?? ch.live)?.active)
}

function titleOf(ch: ChannelDTO) {
  return ch.title || dmTitle(ch.name, ch.participants ?? [], session.user?.id || '')
}

function searchName(member: DmSearchMember) {
  return member.nickname || member.displayName
}
</script>

<template>
  <section class="mt-3">
    <div class="flex min-h-11 items-center pr-2 md:min-h-6">
      <button
        type="button"
        class="flex-1 flex items-center gap-1 pl-3 pr-1 text-xs font-semibold text-muted hover:text-default"
        @click="collapsed = !collapsed"
      >
        <span class="text-start">Direct messages</span>
        <UIcon :name="collapsed ? 'i-ph-caret-right' : 'i-ph-caret-down'" class="size-3" />
      </button>
      <UButton icon="i-ph-plus" color="neutral" variant="ghost" size="xs" square class="size-11 md:size-7" aria-label="New DM" @click="picker = true" />
    </div>
    <ul v-show="!collapsed" class="px-2" role="listbox" aria-label="Direct messages">
      <li v-for="ch in dmsQ.data.value?.channels ?? []" :key="ch.id" class="group relative">
        <NuxtLink
          :to="channelPath(ch)"
          class="flex h-11 items-center gap-2 rounded-md px-2 text-[15px] md:h-8"
          :class="selected === ch.id ? 'bg-accented text-highlighted' : 'text-muted hover:bg-elevated/80 hover:text-default'"
          role="option"
          :aria-selected="selected === ch.id"
          @pointerenter="warm.intent(ch.id)"
          @pointerleave="warm.cancel()"
          @focus="warm.prefetch(ch.id)"
        >
          <UserAvatar v-if="avatarUser(ch)" :user="avatarUser(ch)!" size="2xs" />
          <UAvatar v-else size="2xs" :text="initials(ch)" />
          <span class="truncate flex-1">{{ titleOf(ch) }}</span>
          <UBadge
            v-if="ch.unread && selected !== ch.id"
            color="primary"
            variant="solid"
            size="sm"
            :label="ch.unreadCount && ch.unreadCount > 99 ? '99+' : String(ch.unreadCount || '')"
            :class="ch.unreadCount ? 'min-w-5 justify-center' : 'size-2 rounded-full p-0'"
          />
        </NuxtLink>
        <UButton
          icon="i-ph-x"
          size="xs"
          color="neutral"
          variant="ghost"
          square
          class="absolute end-1 top-1 opacity-0 group-hover:opacity-100"
          title="Close"
          @click.prevent="hide(ch.id)"
        />
        <div v-if="inCall(ch)" class="pl-8 flex gap-1 pb-1 text-success">
          <UIcon name="i-ph-speaker-high" class="size-3" />
        </div>
      </li>
    </ul>

    <UModal v-model:open="picker" title="New Message" description="Find someone in this server, or pick two or more for a group.">
      <template #body>
        <UInput
          v-model="q"
          icon="i-ph-magnifying-glass"
          placeholder="Search name, nickname, or handle"
          autocomplete="off"
          class="w-full"
          role="combobox"
          aria-controls="dm-search-results"
          :aria-expanded="Boolean(searchQ.data.value?.members.length)"
          autofocus
        />
        <ul id="dm-search-results" class="mt-3 max-h-64 overflow-y-auto space-y-0.5" role="listbox">
          <li v-for="m in searchQ.data.value?.members ?? []" :key="m.id" class="flex items-center gap-2">
            <UCheckbox
              :model-value="picked.includes(m.id)"
              :aria-label="`Add ${searchName(m)} to group`"
              @update:model-value="togglePick(m.id)"
            />
            <button type="button" class="flex-1 flex items-center gap-2 h-9 px-1 rounded-md hover:bg-elevated text-start" @click="openDm(m.id)">
              <UserAvatar :user="m" size="xs" />
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm">{{ searchName(m) }}</span>
                <span v-if="m.handle || m.nickname" class="block truncate text-xs text-muted">
                  <template v-if="m.handle">@{{ m.handle }}</template>
                  <template v-if="m.nickname && m.nickname !== m.displayName"> · {{ m.displayName }}</template>
                </span>
              </span>
            </button>
          </li>
        </ul>
      </template>
      <template #footer>
        <UButton
          v-if="picked.length >= 2"
          block
          icon="i-ph-users"
          :label="`Create Group DM (${picked.length + 1})`"
          @click="startGroup"
        />
      </template>
    </UModal>
  </section>
</template>
