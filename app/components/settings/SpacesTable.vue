<script setup lang="ts">
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/vue-query'
import { refDebounced } from '@vueuse/core'
import type { SpaceAdminList, SpaceAdminRow, SpaceAdminSort } from '~~/shared/spaces'
import { formatBytes } from '~~/shared/format'

/** The Owner's table: sorted, filtered and paged on the Server. Counts only. */
const props = defineProps<{ serverId: string }>()
const emit = defineEmits<{ open: [space: SpaceAdminRow] }>()
const { api } = useApi()
const toast = useToast()
const qc = useQueryClient()

const search = ref('')
const q = refDebounced(computed(() => search.value.trim()), 300)
const ALL = 'all'
const limit = ref(ALL), state = ref(ALL)
const sort = ref<SpaceAdminSort>('activity'), dir = ref<'asc' | 'desc'>('desc')
const page = ref(1)
const PAGE_SIZE = 25
watch([q, limit, state, sort, dir], () => { page.value = 1 })

const filtered = computed(() => Boolean(q.value) || limit.value !== ALL || state.value !== ALL)
const listQ = useQuery({
  queryKey: computed(() => ['space-admin', props.serverId, q.value, limit.value, state.value, sort.value, dir.value, page.value]),
  queryFn: () => api<SpaceAdminList>(`/api/servers/${props.serverId}/spaces/admin`, { query: {
    q: q.value, sort: sort.value, dir: dir.value, page: page.value, pageSize: PAGE_SIZE,
    limit: limit.value === ALL ? '' : limit.value, state: state.value === ALL ? '' : state.value,
  } }),
  placeholderData: keepPreviousData,
})
const rows = computed(() => listQ.data.value?.spaces ?? [])
const total = computed(() => listQ.data.value?.total ?? 0)
const pages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))
// One Space has nothing to sort or filter, so those stay out of its way.
const showControls = computed(() => filtered.value || total.value > 1)

const limitItems = [{ label: 'Any usage', value: ALL }, { label: 'Near a limit', value: 'near' }, { label: 'At a limit', value: 'over' }]
const stateItems = [{ label: 'Any state', value: ALL }, { label: 'Inactive 30 days', value: 'inactive' }, { label: 'Suspended', value: 'suspended' }]

const columns: { key: SpaceAdminSort; label: string; numeric?: boolean }[] = [
  { key: 'name', label: 'Space' }, { key: 'creator', label: 'Creator' },
  { key: 'people', label: 'People', numeric: true }, { key: 'projects', label: 'Projects', numeric: true }, { key: 'tasks', label: 'Tasks', numeric: true },
  { key: 'recordings', label: 'Recordings', numeric: true }, { key: 'storage', label: 'Storage', numeric: true }, { key: 'voice', label: 'Voice min', numeric: true },
  { key: 'messages', label: 'Messages', numeric: true }, { key: 'created', label: 'Created' }, { key: 'activity', label: 'Last active' },
]
function sortBy(key: SpaceAdminSort) {
  if (sort.value === key) dir.value = dir.value === 'asc' ? 'desc' : 'asc'
  else { sort.value = key; dir.value = key === 'name' || key === 'creator' ? 'asc' : 'desc' }
}
const ariaSort = (key: SpaceAdminSort) => sort.value === key ? (dir.value === 'asc' ? 'ascending' : 'descending') : 'none'

/** How close a count is to its limit: a limit of nothing is not a warning. */
function usageClass(used: number, max: number | null | undefined) {
  if (max == null || (max === 0 && used === 0)) return 'text-default'
  if (used >= max) return 'font-semibold text-error'
  return used >= max * 0.8 ? 'font-semibold text-warning' : 'text-default'
}
const of = (used: string | number, max: string | number | null | undefined) => max == null ? String(used) : `${used} / ${max}`
const day = (value: string | null) => value ? new Date(value).toLocaleDateString() : '—'

const refreshing = ref(false)
async function refresh() {
  refreshing.value = true
  try {
    await api(`/api/servers/${props.serverId}/spaces/admin/refresh`, { method: 'POST' })
    await qc.invalidateQueries({ queryKey: ['space-admin', props.serverId] })
  }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { refreshing.value = false }
}
const counted = computed(() => listQ.data.value?.refreshedAt ? new Date(listQ.data.value.refreshedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '')
</script>

<template>
  <div class="space-y-3">
    <div v-if="showControls" class="flex flex-wrap items-center gap-2">
      <UInput v-model="search" icon="i-ph-magnifying-glass" placeholder="Search name or creator" aria-label="Search Spaces" class="min-w-48 flex-1" />
      <USelect v-model="limit" :items="limitItems" aria-label="Usage" class="w-36" />
      <USelect v-model="state" :items="stateItems" aria-label="State" class="w-40" />
    </div>

    <LayoutLoadError v-if="listQ.error.value" message="Spaces did not load." :retry="listQ.refetch" />
    <LayoutSkeleton v-else-if="listQ.isPending.value" variant="rows" :rows="4" />
    <template v-else>
      <div class="overflow-x-auto rounded-lg border border-default">
        <table class="w-full min-w-[60rem] text-sm">
          <thead class="bg-elevated/50 text-xs text-muted">
            <tr>
              <th v-for="column in columns" :key="column.key" scope="col" :aria-sort="ariaSort(column.key)" class="whitespace-nowrap px-3 py-2 font-medium" :class="[column.numeric ? 'text-end' : 'text-start', column.key === 'name' ? 'sticky start-0 bg-default' : '']">
                <button type="button" class="inline-flex items-center gap-1 hover:text-default" @click="sortBy(column.key)">
                  {{ column.label }}
                  <UIcon v-if="sort === column.key" :name="dir === 'asc' ? 'i-ph-caret-up' : 'i-ph-caret-down'" class="size-3" />
                </button>
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-default">
            <tr v-for="space in rows" :key="space.id" class="cursor-pointer hover:bg-elevated/50" @click="emit('open', space)">
              <td class="sticky start-0 max-w-56 bg-default px-3 py-2">
                <button type="button" class="block max-w-full truncate text-start font-medium text-highlighted" @click.stop="emit('open', space)">{{ space.name }}</button>
                <span v-if="space.suspended" class="text-xs text-error">Suspended</span>
                <span v-else-if="space.isDefault" class="text-xs text-muted">Default</span>
              </td>
              <td class="max-w-48 truncate px-3 py-2 text-muted" :title="space.creator?.email ?? undefined">{{ space.creator?.name ?? '—' }}</td>
              <td class="px-3 py-2 text-end tabular-nums">{{ space.people }}</td>
              <td class="px-3 py-2 text-end tabular-nums">{{ space.projects }}</td>
              <td class="px-3 py-2 text-end tabular-nums">{{ space.tasks }}</td>
              <td class="px-3 py-2 text-end tabular-nums">{{ space.recordings }}</td>
              <td class="whitespace-nowrap px-3 py-2 text-end tabular-nums" :class="usageClass(space.storageBytes, space.quotas?.storageLimitBytes)">{{ of(formatBytes(space.storageBytes), space.quotas?.storageLimitBytes == null ? null : formatBytes(space.quotas.storageLimitBytes)) }}</td>
              <td class="whitespace-nowrap px-3 py-2 text-end tabular-nums" :class="usageClass(space.voiceMinutes, space.quotas?.monthlyVoiceLimit)">{{ of(space.voiceMinutes, space.quotas?.monthlyVoiceLimit) }}</td>
              <td class="px-3 py-2 text-end tabular-nums">{{ space.messages }}</td>
              <td class="whitespace-nowrap px-3 py-2 text-muted">{{ day(space.createdAt) }}</td>
              <td class="whitespace-nowrap px-3 py-2 text-muted">{{ day(space.lastActivityAt) }}</td>
            </tr>
            <tr v-if="!rows.length"><td :colspan="columns.length" class="px-3 py-6 text-center text-muted">No Spaces match.</td></tr>
          </tbody>
        </table>
      </div>
      <div class="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <span>{{ total }} {{ total === 1 ? 'Space' : 'Spaces' }} · counted at {{ counted }} <UButton label="Count now" variant="link" size="xs" class="p-0 align-baseline" :loading="refreshing" @click="refresh" /></span>
        <div v-if="pages > 1" class="flex items-center gap-2">
          <UButton icon="i-ph-caret-left" color="neutral" variant="ghost" size="xs" square aria-label="Previous page" :disabled="page <= 1" @click="page -= 1" />
          <span>Page {{ page }} of {{ pages }}</span>
          <UButton icon="i-ph-caret-right" color="neutral" variant="ghost" size="xs" square aria-label="Next page" :disabled="page >= pages" @click="page += 1" />
        </div>
      </div>
    </template>
  </div>
</template>
