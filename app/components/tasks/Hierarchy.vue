<script setup lang="ts">
import { useQueryClient } from '@tanstack/vue-query'
import type { TaskDTO, TaskDetailDTO, TaskRelationDTO } from '~~/shared/types'
import { taskDescendants } from '~~/shared/task-hierarchy'
import { Permission } from '~~/shared/permissions'
import { BOARD_ROUTE } from '~~/shared/paths'

const props = defineProps<{ task: TaskDetailDTO; tasks: TaskDTO[]; dirty: boolean }>()
const emit = defineEmits<{ create: [] }>()
const { api } = useApi()
const { can } = useRoleGrants()
const cache = useQueryClient()
const toast = useToast()
const busy = ref(false)
const parentChoice = ref<string>()
const childChoice = ref<string>()
watch(() => props.task.id, () => { parentChoice.value = undefined; childChoice.value = undefined })
const canWrite = computed(() => can(Permission.writeTasks, props.task.projectId))
const writable = computed(() => canWrite.value && !props.task.archivedAt)
const disabled = computed(() => busy.value || props.dirty)
const scoped = computed(() => props.tasks.filter(t => t.boardId === props.task.boardId && (t.projectId ?? null) === (props.task.projectId ?? null) && !t.archivedAt))
const label = (task: Pick<TaskDTO, 'number' | 'title'>) => `#${task.number} ${task.title}`
const parentChoices = computed(() => {
  const descendants = taskDescendants(props.tasks, props.task.id)
  return scoped.value.filter(t => !descendants.has(t.id) && t.id !== props.task.parentTaskId).map(t => ({ label: label(t), value: t.id }))
})
const childChoices = computed(() => scoped.value.filter(t => !t.parentTaskId && t.id !== props.task.id && !taskDescendants(props.tasks, t.id).has(props.task.id)).map(t => ({ label: label(t), value: t.id })))
const link = (task: TaskRelationDTO) => ({ path: BOARD_ROUTE, query: { board: task.boardId, task: task.id } })
async function setParent(taskId: string, parentTaskId: string | null) {
  if (disabled.value) return
  busy.value = true
  try {
    await api(`/api/tasks/${taskId}`, { method: 'PATCH', body: { parentTaskId } })
    parentChoice.value = undefined; childChoice.value = undefined
    await Promise.all([cache.invalidateQueries({ queryKey: ['boards'] }), cache.invalidateQueries({ queryKey: ['task'] })])
  } catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { busy.value = false }
}
</script>

<template>
  <section class="mb-6 space-y-4 rounded-lg border border-default p-3" aria-label="Task hierarchy">
    <div v-if="task.parent" class="flex min-w-0 items-center gap-2">
      <span class="text-xs text-muted">Parent</span>
      <ULink :to="link(task.parent)" class="min-w-0 flex-1 truncate text-sm text-primary" :aria-label="`Open parent ${label(task.parent)}`">{{ label(task.parent) }}</ULink>
      <UBadge v-if="task.parent.archivedAt" label="Archived" color="neutral" size="xs" />
      <UButton v-if="canWrite" label="Detach" aria-label="Detach from parent" color="neutral" variant="ghost" size="xs" :disabled="disabled" @click="setParent(task.id, null)" />
    </div>
    <div v-if="writable && parentChoices.length" class="flex flex-wrap items-end gap-2">
      <UFormField :label="task.parent ? 'Change parent' : 'Parent task'" class="min-w-0 flex-1">
        <USelectMenu v-model="parentChoice" aria-label="Choose parent task" :items="parentChoices" value-key="value" placeholder="Choose a task" :disabled="disabled" class="w-full" />
      </UFormField>
      <UButton label="Set parent" size="sm" color="neutral" variant="outline" :disabled="disabled || !parentChoice" @click="setParent(task.id, parentChoice ?? null)" />
    </div>
    <div class="space-y-2">
      <div class="flex flex-wrap items-center gap-2">
        <h3 class="text-sm font-medium">Subtasks</h3>
        <span class="text-xs text-muted" role="status">{{ task.subtaskCompleted }}/{{ task.subtaskTotal }} done</span>
        <UButton v-if="writable" label="Create subtask" icon="i-ph-plus" color="neutral" variant="ghost" size="xs" class="ms-auto" :disabled="disabled" @click="emit('create')" />
      </div>
      <progress v-if="task.subtaskTotal" :value="task.subtaskCompleted" :max="task.subtaskTotal" aria-label="Subtask completion" class="h-1.5 w-full accent-primary" />
      <ul v-if="task.subtasks?.length" class="divide-y divide-default">
        <li v-for="child in task.subtasks" :key="child.id" class="flex min-w-0 items-center gap-2 py-2">
          <UIcon :name="child.status === 'done' ? 'i-ph-check-circle' : 'i-ph-circle'" class="size-4 shrink-0 text-muted" />
          <ULink :to="link(child)" class="min-w-0 flex-1 truncate text-sm text-primary">{{ label(child) }}</ULink>
          <span class="text-xs text-muted">{{ child.archivedAt ? 'Archived' : child.status }}</span>
          <UButton v-if="canWrite" icon="i-ph-x" :aria-label="`Detach ${label(child)}`" color="neutral" variant="ghost" size="xs" :disabled="disabled" @click="setParent(child.id, null)" />
        </li>
      </ul>
      <p v-else class="text-xs text-muted">Break this task into work with its own assignee, status and due date.</p>
      <div v-if="writable && childChoices.length" class="flex flex-wrap items-end gap-2">
        <UFormField label="Link existing task" class="min-w-0 flex-1">
          <USelectMenu v-model="childChoice" aria-label="Choose existing subtask" :items="childChoices" value-key="value" placeholder="Choose a task" :disabled="disabled" class="w-full" />
        </UFormField>
        <UButton label="Link subtask" size="sm" color="neutral" variant="outline" :disabled="disabled || !childChoice" @click="setParent(childChoice!, task.id)" />
      </div>
      <p v-if="dirty && writable" class="text-xs text-muted" role="status">Save or reset your edits before changing subtasks.</p>
      <p class="text-xs text-muted">Statuses and archives are independent. Progress counts active direct subtasks. Deleting a parent keeps its subtasks.</p>
    </div>
  </section>
</template>
