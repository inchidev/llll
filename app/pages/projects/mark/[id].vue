<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { RecordingLimitsDTO } from '~~/shared/task-recordings'
import type { TaskBoardDTO, TaskDetailDTO } from '~~/shared/types'

// Where the phone's Shortcut lands: the recording is already a Task, and this marks it. It covers the whole screen.
definePageMeta({ middleware: ['auth'], layout: false })

const route = useRoute()
const { api, serverUrl } = useApi()
const { serverId } = useServer()
const { remember } = useSpaces(serverId)
const qc = useQueryClient()
const { remember: rememberBoard } = useBoardChoice(serverId)
const taskId = String(route.params.id)
const keyId = typeof route.query.key === 'string' ? route.query.key : null

// The key's Space, before anything below asks for that Space's boards.
const spaceFromLink = typeof route.query.space === 'string' ? route.query.space : null
const spaceReady = computed(() => Boolean(serverId.value))
watch(serverId, (id) => { if (id && spaceFromLink) remember(spaceFromLink) }, { immediate: true })

const taskQ = useQuery({ queryKey: ['mark-task', taskId], queryFn: () => api<{ task: TaskDetailDTO }>(`/api/tasks/${taskId}`), enabled: spaceReady, retry: false, refetchOnWindowFocus: false })
const limitsQ = useQuery({ queryKey: computed(() => ['recording-limits', serverId.value]), queryFn: () => api<{ limits: RecordingLimitsDTO }>(`/api/servers/${serverId.value}/recording-limits`), enabled: spaceReady })
const boardsQ = useQuery({ queryKey: computed(() => ['mark-boards', serverId.value]), queryFn: () => api<{ boards: TaskBoardDTO[] }>(`/api/servers/${serverId.value}/boards`), enabled: spaceReady })

const task = computed(() => taskQ.data.value?.task ?? null)
const recording = computed(() => task.value?.attachments.find(attachment => attachment.role === 'recording') ?? null)
const uploaded = computed(() => task.value && recording.value ? { id: recording.value.id, taskId: task.value.id, url: serverUrl(recording.value.url), contentType: recording.value.contentType } : null)
const boardPath = (boardId: string | null | undefined) => ({ path: '/projects/board', query: { board: boardId ?? undefined, task: taskId } })

// A marked recording has its frames already: going back here opens the Task rather than marking twice.
watch([task, recording], ([current, attachment]) => {
  if (current && (!attachment || attachment.marks)) void navigateTo(boardPath(current.boardId), { replace: true })
}, { immediate: true })

const boards = computed(() => (boardsQ.data.value?.boards ?? []).filter(board => !board.archivedAt))
const boardId = ref<string | undefined>()
watch(task, (current) => { if (current && !boardId.value) boardId.value = current.boardId }, { immediate: true })
const boardItems = computed(() => boards.value.map(board => ({ label: board.name, value: board.id })))

const later = () => navigateTo(boardPath(task.value?.boardId))

const moveError = ref('')
async function saved() {
  const target = boardId.value
  try {
    if (target && target !== task.value?.boardId) await api(`/api/tasks/${taskId}`, { method: 'PATCH', body: { boardId: target } })
    if (target && keyId && target !== task.value?.boardId) await api(`/api/me/recording-keys/${keyId}`, { method: 'PATCH', body: { boardId: target } })
  }
  catch (cause) {
    // The marks are saved: the Task only stayed on its first board. Say so, then show it there.
    moveError.value = errorMessage(cause)
    useToast().add({ title: 'Saved, but not moved', description: moveError.value, color: 'warning' })
    await navigateTo(boardPath(task.value?.boardId))
    return
  }
  // The board page on this device opens on the same board.
  if (target) rememberBoard(target)
  await qc.invalidateQueries({ queryKey: ['boards'] })
  await navigateTo(boardPath(target ?? task.value?.boardId))
}
</script>

<template>
  <div class="fixed inset-0 bg-default">
    <TasksRecordingMarker v-if="uploaded && limitsQ.data.value" :uploaded="uploaded" :limits="limitsQ.data.value.limits" @sent="saved" @cancel="later">
      <template #destination>
        <div v-if="boardItems.length" class="flex gap-1.5">
          <USelect v-model="boardId" :items="boardItems" size="sm" class="min-w-0 flex-1" aria-label="Board" />
        </div>
      </template>
    </TasksRecordingMarker>
    <div v-else-if="taskQ.isError.value" class="mx-auto max-w-md space-y-4 p-6">
      <h1 class="text-lg font-semibold text-highlighted">This recording isn’t here</h1>
      <p class="text-sm text-muted">It may have been deleted, or this browser is signed in to a different Account from the one that made the key.</p>
      <UButton to="/projects/board" label="Go to Tasks" color="neutral" variant="outline" />
    </div>
    <div v-else class="grid h-full place-items-center text-sm text-muted" role="status">Loading…</div>
  </div>
</template>
