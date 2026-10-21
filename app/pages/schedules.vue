<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { ChannelDTO, TaskBoardDTO } from '~~/shared/types'
import type { Schedule } from '~~/shared/schedules'
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
const timezone = ref(Intl.DateTimeFormat().resolvedOptions().timeZone)
const recurrence = ref<'once' | 'daily' | 'weekly'>('once')
const kind = ref<'reminder' | 'work'>('reminder')
const taskId = ref('')
const schedules = useQuery({ queryKey: ['schedules'], queryFn: () => api<{ schedules: Omit<Schedule, 'authorizationJson' | 'mandateJson'>[] }>('/api/schedules'),
  enabled: computed(() => can(Permission.manageSchedules)), refetchInterval: 15000 })
const channels = useQuery({ queryKey: computed(() => ['channels', serverId.value]), queryFn: () => api<{ channels: ChannelDTO[] }>(`/api/servers/${serverId.value}/channels`) })
const dms = useQuery({ queryKey: ['dms'], queryFn: () => api<{ channels: ChannelDTO[] }>('/api/dms') })
const boards = useQuery({ queryKey: computed(() => ['schedule-tasks', serverId.value]), queryFn: () => api<{ boards: TaskBoardDTO[] }>(`/api/servers/${serverId.value}/boards`),
  enabled: computed(() => kind.value === 'work' && can(Permission.readTasks)) })
const channelOptions = computed(() => [...(channels.data.value?.channels ?? []), ...(dms.data.value?.channels ?? [])].map(channel => ({ label: channel.name, value: channel.id })))
const tasks = computed(() => boards.data.value?.boards.flatMap(board => board.tasks).filter(task => task.assigneeId && !task.archivedAt) ?? [])
async function create() {
  busy.value = true
  try {
    const task = tasks.value.find(task => task.id === taskId.value)
    await api('/api/schedules', { method: 'POST', body: { kind: kind.value, channelId: channelId.value, content: content.value,
      firstAt: new Date(firstAt.value).toISOString(), timezone: timezone.value, recurrence: recurrence.value,
      ...(kind.value === 'work' ? { taskId: taskId.value, agentId: task?.assigneeId } : {}) } })
    content.value = ''; await schedules.refetch()
  } catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { busy.value = false }
}
async function cancel(id: string) {
  try { await api(`/api/schedules/${id}`, { method: 'DELETE' }); await schedules.refetch() }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
}
</script>

<template>
  <main class="mx-auto w-full max-w-3xl space-y-6 overflow-auto p-4 sm:p-8">
    <h1 class="text-lg font-medium">Reminders and recurring work</h1>
    <UAlert v-if="!can(Permission.manageSchedules)" title="Your role does not allow schedules" color="neutral" />
    <template v-else>
      <form class="space-y-4 rounded-lg border border-default p-4" @submit.prevent="create">
        <UFormField label="What should happen?"><UTextarea v-model="content" class="w-full" required placeholder="Review the market research" /></UFormField>
        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField label="Action"><USelect v-model="kind" class="w-full" :items="[{ label: 'Reminder', value: 'reminder' }, ...(can(Permission.executeTasks) ? [{ label: 'Run an assigned task', value: 'work' }] : [])]" /></UFormField>
          <UFormField label="Conversation"><USelect v-model="channelId" :items="channelOptions" class="w-full" required /></UFormField>
          <UFormField v-if="kind === 'work'" label="Assigned task"><USelect v-model="taskId" :items="tasks.map(task => ({ label: task.title, value: task.id }))" class="w-full" required /></UFormField>
          <UFormField label="First time" help="Enter time in your device’s timezone."><UInput v-model="firstAt" type="datetime-local" class="w-full" required /></UFormField>
          <UFormField label="Repeat"><USelect v-model="recurrence" class="w-full" :items="[{ label: 'Once', value: 'once' }, { label: 'Daily', value: 'daily' }, { label: 'Weekly', value: 'weekly' }]" /></UFormField>
          <UFormField label="Timezone for repetitions"><UInput v-model="timezone" class="w-full" required /></UFormField>
        </div>
        <UButton type="submit" label="Schedule" :loading="busy" :disabled="!content.trim() || !channelId || !firstAt" />
      </form>
      <LayoutLoadError v-if="schedules.error.value" message="Schedules did not load." :retry="schedules.refetch" />
      <article v-for="item in schedules.data.value?.schedules ?? []" :key="item.id" class="space-y-2 rounded-lg border border-default p-4">
        <div class="flex items-center justify-between gap-3"><p class="text-sm">{{ item.content }}</p><UBadge :label="item.status" color="neutral" variant="subtle" /></div>
        <p class="text-xs text-muted">{{ item.nextAt ? new Date(item.nextAt).toLocaleString() : 'No further deliveries' }} · {{ item.recurrence }} · {{ item.timezone }}</p>
        <UAlert v-if="item.lastError" :description="item.lastError" color="error" />
        <UButton v-if="item.status === 'active'" label="Cancel" color="neutral" variant="ghost" size="sm" @click="cancel(item.id)" />
      </article>
    </template>
  </main>
</template>
