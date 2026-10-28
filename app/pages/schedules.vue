<script setup lang="ts">
import { useInfiniteQuery, useQuery } from '@tanstack/vue-query'
import type { ChannelDTO, TaskAgentDTO, TaskBoardDTO } from '~~/shared/types'
import { formatScheduleTime, relativeScheduleTime, resolveScheduleTime, scheduleErrorHint, type PublicSchedule, type ScheduleListPage, type ScheduleStatusFilter } from '~~/shared/schedules'
import { Permission } from '~~/shared/permissions'

definePageMeta({ layout: 'server', middleware: ['auth'] })
const { api } = useApi()
const { serverId } = useServer()
const { can } = useRoleGrants()
const toast = useToast()
const busy = ref(false)
const content = ref('')
const channelId = ref('')
const firstAt = ref('')
const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone
const timezone = ref(browserZone)
const timezones = [...new Set([browserZone, 'UTC', ...((Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? [])])].sort()
const recurrence = ref<'once' | 'daily' | 'weekly'>('once')
const kind = ref<'reminder' | 'work'>('reminder')
const taskId = ref('')
const status = ref<ScheduleStatusFilter>('current')
const statusItems = [{ label: 'Current', value: 'current' }, { label: 'Active', value: 'active' }, { label: 'Paused', value: 'paused' },
  { label: 'Blocked', value: 'blocked' }, { label: 'History', value: 'history' }]
const schedules = useInfiniteQuery({
  queryKey: computed(() => ['schedules', status.value]),
  queryFn: ({ pageParam }) => api<ScheduleListPage & { workAvailable: boolean }>('/api/schedules', { query: { status: status.value, ...(pageParam ? { cursor: pageParam } : {}) } }),
  initialPageParam: '' as string,
  getNextPageParam: last => last.nextCursor ?? undefined,
  enabled: computed(() => can(Permission.manageSchedules)), refetchInterval: 15000,
})
const firstPage = computed(() => schedules.data.value?.pages[0])
const items = computed(() => schedules.data.value?.pages.flatMap(page => page.schedules) ?? [])
const workAvailable = computed(() => firstPage.value?.workAvailable ?? false)
const channels = useQuery({ queryKey: computed(() => ['channels', serverId.value]), queryFn: () => api<{ channels: ChannelDTO[] }>(`/api/servers/${serverId.value}/channels`) })
const dms = useQuery({ queryKey: ['dms'], queryFn: () => api<{ channels: ChannelDTO[] }>('/api/dms') })
const boards = useQuery({ queryKey: computed(() => ['schedule-tasks', serverId.value]), queryFn: () => api<{ boards: TaskBoardDTO[] }>(`/api/servers/${serverId.value}/boards`),
  enabled: computed(() => kind.value === 'work' && can(Permission.readTasks)) })
const channelOptions = computed(() => [...(channels.data.value?.channels ?? []), ...(dms.data.value?.channels ?? [])].map(channel => ({ label: channel.name, value: channel.id })))
const agents = useQuery({ queryKey: computed(() => ['schedule-agents', serverId.value]), queryFn: () => api<{ agents: TaskAgentDTO[] }>(`/api/servers/${serverId.value}/task-agents`), enabled: computed(() => kind.value === 'work' && can(Permission.readTasks)) })
const tasks = computed(() => boards.data.value?.boards.flatMap(board => board.tasks).filter(task => agents.data.value?.agents.some(agent => agent.id === task.assigneeId && agent.status === 'active') && !task.archivedAt && task.status !== 'done') ?? [])
const actionItems = computed(() => [{ label: 'Reminder', value: 'reminder' },
  ...(can(Permission.executeTasks) ? [{ label: 'Run an assigned task', value: 'work', disabled: !workAvailable.value }] : [])])
watch(workAvailable, available => { if (!available && kind.value === 'work') kind.value = 'reminder' })
const resolved = computed(() => resolveScheduleTime(firstAt.value, timezone.value))
const preview = computed(() => {
  if (!resolved.value) return null
  const local = timezone.value === browserZone ? '' : ` · ${formatScheduleTime(resolved.value.at)} your time`
  return `Runs ${formatScheduleTime(resolved.value.at, timezone.value)} (${timezone.value})${local} · ${relativeScheduleTime(resolved.value.at)}`
})
const dstWarning = computed(() => resolved.value?.issue === 'gap'
  ? `That time does not exist in ${timezone.value} on this date because clocks move forward. It will run at ${resolved.value.wallTime.slice(11)} instead.`
  : resolved.value?.issue === 'overlap' ? `That time happens twice in ${timezone.value} on this date because clocks move back. The first occurrence is used.` : null)
async function refresh() { await schedules.refetch() }
async function create() {
  if (!resolved.value) { toast.add({ title: 'Choose a valid time and timezone', color: 'error' }); return }
  busy.value = true
  try {
    const task = tasks.value.find(task => task.id === taskId.value)
    await api('/api/schedules', { method: 'POST', body: { kind: kind.value, channelId: channelId.value, content: content.value,
      firstAt: resolved.value.at, timezone: timezone.value, recurrence: recurrence.value,
      ...(kind.value === 'work' ? { taskId: taskId.value, agentId: task?.assigneeId } : {}) } })
    content.value = ''; await refresh()
  } catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { busy.value = false }
}
async function act(item: PublicSchedule, action: 'pause' | 'resume' | 'dismiss' | 'cancel') {
  try {
    if (action === 'cancel') await api(`/api/schedules/${item.id}`, { method: 'DELETE' })
    else await api(`/api/schedules/${item.id}`, { method: 'PATCH', body: { action } })
    await refresh()
  } catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
}
const statusColor = (value: PublicSchedule['status']) => value === 'blocked' ? 'error' : value === 'paused' ? 'warning' : value === 'active' ? 'success' : 'neutral'
const history = ref<string | null>(null)
</script>

<template>
  <div class="flex h-full min-h-0 min-w-0 flex-col">
    <LayoutPageHeader title="Schedules" icon="i-ph-clock" />
    <main class="mx-auto w-full max-w-3xl flex-1 space-y-6 overflow-auto p-4 sm:p-8">
    <h2 class="text-lg font-medium">Reminders and recurring work</h2>
    <UAlert v-if="!can(Permission.manageSchedules)" title="Your role does not allow schedules" color="neutral" />
    <template v-else>
      <form class="space-y-4 rounded-lg border border-default p-4" @submit.prevent="create">
        <UFormField label="What should happen?"><UTextarea v-model="content" class="w-full" required placeholder="Review the market research" /></UFormField>
        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField label="Action" :help="can(Permission.executeTasks) && !workAvailable ? 'Running tasks needs agent execution, which this Server has not configured.' : undefined">
            <USelect v-model="kind" class="w-full" :items="actionItems" />
          </UFormField>
          <UFormField label="Conversation"><USelect v-model="channelId" :items="channelOptions" class="w-full" required /></UFormField>
          <UFormField v-if="kind === 'work'" label="Assigned task"><USelect v-model="taskId" :items="tasks.map(task => ({ label: task.title, value: task.id }))" class="w-full" required /></UFormField>
          <UFormField label="First time" help="Enter time in the selected timezone."><UInput v-model="firstAt" type="datetime-local" class="w-full" required /></UFormField>
          <UFormField label="Repeat"><USelect v-model="recurrence" class="w-full" :items="[{ label: 'Once', value: 'once' }, { label: 'Daily', value: 'daily' }, { label: 'Weekly', value: 'weekly' }]" /></UFormField>
          <UFormField label="Timezone">
            <USelectMenu v-model="timezone" :items="timezones" aria-label="Timezone" :search-input="{ placeholder: 'Search timezones' }" virtualize class="w-full" />
          </UFormField>
        </div>
        <p v-if="preview" class="text-sm text-muted" aria-live="polite">{{ preview }}</p>
        <UAlert v-if="dstWarning" :description="dstWarning" color="warning" variant="subtle" icon="i-ph-warning" />
        <div class="flex flex-wrap items-center gap-3">
          <UButton type="submit" label="Schedule" :loading="busy" :disabled="!content.trim() || !channelId || !resolved" />
          <span v-if="firstPage" class="text-xs text-muted">{{ firstPage.activeCount }} of {{ firstPage.activeLimit }} active</span>
        </div>
      </form>
      <UTabs v-model="status" :items="statusItems" :content="false" variant="link" />
      <LayoutLoadError v-if="schedules.error.value" message="Schedules did not load." :retry="schedules.refetch" />
      <LayoutEmptyState
        v-else-if="schedules.isSuccess.value && !items.length" icon="i-ph-clock"
        :title="status === 'current' ? 'No schedules yet' : 'Nothing here'"
        :description="status === 'current' ? 'A reminder posts a message to a conversation and notifies you. Recurring work starts an agent Run on its assigned task.' : 'No schedules match this filter.'" />
      <article v-for="item in items" :key="item.id" class="space-y-2 rounded-lg border border-default p-4">
        <div class="flex items-center justify-between gap-3">
          <p class="text-sm" :class="{ 'text-muted italic': item.unavailable }">{{ item.unavailable ? 'Conversation unavailable' : item.content }}</p>
          <UBadge :label="item.status" :color="statusColor(item.status)" variant="subtle" />
        </div>
        <p class="text-xs text-muted">
          <template v-if="item.nextAt && ['active', 'paused'].includes(item.status)">
            {{ formatScheduleTime(item.nextAt, item.timezone) }} ({{ item.timezone }})<template v-if="item.timezone !== browserZone"> · {{ formatScheduleTime(item.nextAt) }} your time</template> · {{ relativeScheduleTime(item.nextAt) }}
          </template>
          <template v-else>No further deliveries · {{ item.timezone }}</template>
          · {{ item.kind === 'work' ? 'task run' : 'reminder' }} · {{ item.recurrence }}
        </p>
        <UAlert v-if="item.lastError" :title="item.lastError" :description="scheduleErrorHint(item.lastErrorCode) ?? undefined" :color="item.status === 'blocked' ? 'error' : 'warning'" variant="subtle" />
        <div class="flex flex-wrap gap-1">
          <UButton v-if="item.status === 'active'" label="Pause" color="neutral" variant="ghost" size="sm" @click="act(item, 'pause')" />
          <UButton v-if="item.status === 'paused' || item.status === 'blocked'" label="Resume" color="neutral" variant="ghost" size="sm" @click="act(item, 'resume')" />
          <UButton v-if="['active', 'paused', 'blocked'].includes(item.status)" label="Cancel" color="neutral" variant="ghost" size="sm" @click="act(item, 'cancel')" />
          <UButton v-if="item.status === 'completed' || item.status === 'cancelled'" label="Remove" color="neutral" variant="ghost" size="sm" @click="act(item, 'dismiss')" />
          <UButton :label="history === item.id ? 'Hide history' : 'History'" color="neutral" variant="ghost" size="sm" :aria-expanded="history === item.id" @click="history = history === item.id ? null : item.id" />
        </div>
        <SchedulesHistory v-if="history === item.id" :schedule="item" />
      </article>
      <UButton v-if="schedules.hasNextPage.value" label="Load more" color="neutral" variant="outline" :loading="schedules.isFetchingNextPage.value" @click="schedules.fetchNextPage()" />
    </template>
    </main>
  </div>
</template>
