<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { TaskBoardDTO } from '~~/shared/types'
import { boardPath } from '~~/shared/paths'

const props = defineProps<{ workspaceId: string }>()
const route = useRoute()
const { api } = useApi()
const nav = useNavActions()

const archived = computed(() => route.query.archived === '1')
const boardsQ = useQuery({
  queryKey: computed(() => ['boards', props.workspaceId, archived.value]),
  queryFn: () => api<{ boards: TaskBoardDTO[] }>(`/api/workspaces/${props.workspaceId}/boards`, { query: { archived: archived.value } }),
  enabled: computed(() => Boolean(props.workspaceId)),
})
const boards = computed(() => {
  const list = boardsQ.data.value?.boards ?? []
  if (!archived.value) return list
  return list.filter(board => Boolean(board.archivedAt) || board.tasks.some(task => Boolean(task.archivedAt)))
})
const activeBoardId = computed(() => String(route.query.board || '') || boards.value[0]?.id || '')
</script>

<template>
  <div>
    <LayoutNavSection
      label="Boards"
      collapse-key="tasks:boards"
      :create-label="archived ? undefined : 'Create board'"
      @create="nav.createBoardOpen.value = true"
    >
      <LayoutSkeleton v-if="boardsQ.isPending.value" variant="nav" :rows="3" />
      <p v-else-if="!boards.length" class="px-2 py-3 text-sm text-muted">
        {{ archived ? 'Nothing archived.' : 'No boards yet.' }}
      </p>
      <ul v-else>
        <li v-for="board in boards" :key="board.id">
          <LayoutNavRow :to="boardPath(board.id, archived)" :active="board.id === activeBoardId">
            <template #leading>
              <UIcon name="i-ph-kanban" class="size-[18px] shrink-0 text-dimmed" />
            </template>
            {{ board.name }}
            <template #trailing>
              <span v-if="board.tasks.length" class="shrink-0 text-[11px] text-dimmed">{{ board.tasks.length }}</span>
            </template>
          </LayoutNavRow>
        </li>
      </ul>
    </LayoutNavSection>

    <div v-if="!boardsQ.isPending.value" class="mt-3 px-2">
      <LayoutNavRow :to="boardPath(null, !archived)" :active="archived">
        <template #leading>
          <UIcon name="i-ph-archive" class="size-[18px] shrink-0 text-dimmed" />
        </template>
        Archived
      </LayoutNavRow>
    </div>
  </div>
</template>
