<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { BOARD_ROUTE, boardPath } from '~~/shared/paths'
import { Permission } from '~~/shared/permissions'
import { myTasks } from '~~/shared/project-navigation'
import type { TaskBoardDTO } from '~~/shared/types'

const props = defineProps<{ serverId: string }>()
const route = useRoute()
const { api } = useApi()
const nav = useNavActions()
const session = useSessionStore()
const { can, canAnyProject } = useRoleGrants()
const { activeBoardId } = useBoardChoice(() => props.serverId)

const onBoard = computed(() => route.path === BOARD_ROUTE)
const archived = computed(() => onBoard.value && route.query.archived === '1')
const boardsQ = useQuery({
  queryKey: computed(() => ['boards', props.serverId, archived.value]),
  queryFn: () => api<{ boards: TaskBoardDTO[] }>(`/api/servers/${props.serverId}/boards`, { query: { archived: archived.value } }),
  enabled: computed(() => Boolean(props.serverId) && canAnyProject(Permission.readTasks)),
})
const boards = computed(() => {
  const list = boardsQ.data.value?.boards ?? []
  return archived.value ? list.filter(board => Boolean(board.archivedAt) || board.tasks.some(task => Boolean(task.archivedAt))) : list
})
const mine = computed(() => {
  if (archived.value) return 0
  const { assigned, review } = myTasks(boards.value, session.user?.id)
  return assigned.length + review.length
})
</script>

<template>
  <div class="space-y-3">
    <div class="px-2">
      <LayoutNavRow to="/projects/my-tasks" :active="route.path === '/projects/my-tasks'">
        <template #leading><UIcon name="i-ph-user-check" class="size-[18px] shrink-0 text-dimmed" /></template>
        My tasks
        <template #trailing><span v-if="mine" class="shrink-0 text-[11px] tabular-nums text-dimmed">{{ mine }}</span></template>
      </LayoutNavRow>
    </div>

    <LayoutNavSection
      label="Boards"
      collapse-key="tasks:boards"
      :create-label="!archived && can(Permission.manageTasks) ? 'Create board' : undefined"
      @create="nav.openCreateBoard()"
    >
      <LayoutSkeleton v-if="boardsQ.isPending.value" variant="nav" :rows="3" />
      <LayoutLoadError v-else-if="boardsQ.error.value" inline message="Boards did not load." :retry="boardsQ.refetch" />
      <p v-else-if="!boards.length" class="px-2 py-3 text-sm text-muted">{{ archived ? 'Nothing archived.' : 'No boards yet.' }}</p>
      <ul v-else>
        <li v-for="board in boards" :key="board.id">
          <LayoutNavRow :to="boardPath(board.id, archived)" :title="board.name" :active="onBoard && board.id === activeBoardId">
            <template #leading><UIcon name="i-ph-kanban" class="size-[18px] shrink-0 text-dimmed" /></template>
            {{ board.name }}
            <template #trailing><span v-if="board.tasks.length" class="shrink-0 text-[11px] tabular-nums text-dimmed">{{ board.tasks.length }}</span></template>
          </LayoutNavRow>
        </li>
      </ul>
    </LayoutNavSection>

    <div v-if="!boardsQ.isPending.value" class="px-2">
      <LayoutNavRow :to="boardPath(null, !archived)" :active="archived">
        <template #leading><UIcon name="i-ph-archive" class="size-[18px] shrink-0 text-dimmed" /></template>
        Archived
      </LayoutNavRow>
    </div>
  </div>
</template>
