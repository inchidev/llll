<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { formatMessageTime } from '~~/shared/format'
import { BOARD_ROUTE } from '~~/shared/paths'
import { myTasks } from '~~/shared/project-navigation'
import type { TaskBoardDTO } from '~~/shared/types'

definePageMeta({ layout: 'server', middleware: ['auth', 'manage-tasks'] })
const { api } = useApi()
const { serverId } = useServer()
const session = useSessionStore()
const boardsQ = useQuery({
  queryKey: computed(() => ['boards', serverId.value, false]),
  queryFn: () => api<{ boards: TaskBoardDTO[] }>(`/api/servers/${serverId.value}/boards`, { query: { archived: false } }),
  enabled: computed(() => Boolean(serverId.value)),
})
const tasks = computed(() => myTasks(boardsQ.data.value?.boards ?? [], session.user?.id))
const sections = computed(() => [
  { key: 'assigned', title: 'Assigned to you', rows: tasks.value.assigned },
  { key: 'review', title: 'Waiting for your review', rows: tasks.value.review },
].filter(section => section.rows.length))
const placeOf = (board: TaskBoardDTO) => board.name
const statusLabels: Record<string, string> = { backlog: 'Backlog', ready: 'Ready', review: 'Review', done: 'Done', failed: 'Failed' }
</script>

<template>
  <div class="flex h-full min-h-0 min-w-0 flex-col">
    <LayoutPageHeader icon="i-ph-user-check" :crumbs="[{ label: 'My tasks' }]" />
    <main class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto max-w-3xl space-y-6 p-4 sm:p-8">
        <LayoutSkeleton v-if="boardsQ.isPending.value" variant="rows" :rows="4" />
        <LayoutLoadError v-else-if="boardsQ.error.value" message="Tasks did not load." :retry="boardsQ.refetch" />
        <LayoutEmptyState v-else-if="!sections.length" icon="i-ph-user-check" title="Nothing on your list" description="Tasks assigned to you in this Space, and your Tasks waiting for review, appear here." />
        <section v-for="section in sections" v-else :key="section.key" class="space-y-2">
          <h2 class="text-sm font-medium text-muted">{{ section.title }}</h2>
          <ul class="divide-y divide-default rounded-lg border border-default">
            <li v-for="{ task, board } in section.rows" :key="task.id">
              <NuxtLink :to="{ path: BOARD_ROUTE, query: { board: board.id, task: task.id } }" class="flex min-h-14 items-center gap-3 px-3 py-2 hover:bg-elevated/60">
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm font-medium text-highlighted"><span class="me-1 font-normal text-muted">#{{ task.number }}</span>{{ task.title }}</span>
                  <span class="block truncate text-xs text-muted">{{ placeOf(board) }}<template v-if="task.dueAt"> · Due {{ formatMessageTime(task.dueAt) }}</template></span>
                </span>
                <UBadge :label="statusLabels[task.status] ?? task.status" color="neutral" variant="subtle" size="sm" class="shrink-0" />
              </NuxtLink>
            </li>
          </ul>
        </section>
      </div>
    </main>
  </div>
</template>
