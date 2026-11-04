<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { channelPath } from '~~/shared/paths'
import { formatScheduleTime, type PublicSchedule, type ScheduleOccurrence } from '~~/shared/schedules'

const props = defineProps<{ schedule: PublicSchedule }>()
const { api } = useApi()
const occurrences = useQuery({ queryKey: computed(() => ['schedule-occurrences', props.schedule.id]),
  queryFn: () => api<{ occurrences: ScheduleOccurrence[] }>(`/api/schedules/${props.schedule.id}/occurrences`) })
function outcome(row: ScheduleOccurrence) {
  if (row.completedAt) return props.schedule.kind === 'work' ? 'Run started' : 'Delivered'
  if (row.failedAt) return `Missed after ${row.attempts} attempts`
  return row.attempts ? `Retrying (${row.attempts} failed)` : 'Pending'
}
</script>

<template>
  <div class="rounded-md bg-elevated/50 p-3 text-xs">
    <LayoutLoadError v-if="occurrences.error.value" message="History did not load." :retry="occurrences.refetch" />
    <p v-else-if="occurrences.isSuccess.value && !occurrences.data.value?.occurrences.length" class="text-muted">No occurrences yet.</p>
    <ul v-else class="space-y-1">
      <li v-for="row in occurrences.data.value?.occurrences ?? []" :key="row.dueAt" class="flex flex-wrap items-center gap-x-2">
        <span>{{ formatScheduleTime(row.dueAt, schedule.timezone) }}</span>
        <span :class="row.failedAt ? 'text-error' : 'text-muted'">{{ outcome(row) }}</span>
        <NuxtLink v-if="row.messageId && !schedule.unavailable" :to="`${channelPath(schedule.channelId)}?message=${row.messageId}`" class="text-primary underline">Message</NuxtLink>
        <NuxtLink v-if="row.runId" :to="`/runs/${row.runId}`" class="text-primary underline">Run</NuxtLink>
        <span v-if="row.lastError && !row.completedAt" class="text-muted">{{ row.lastError }}</span>
      </li>
    </ul>
  </div>
</template>
