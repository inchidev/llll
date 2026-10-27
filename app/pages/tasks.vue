<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { CodeEnvironment } from '~~/shared/code-environments'
import { hasPermission, Permission } from '~~/shared/permissions'
import type {
  ChannelDTO,
  MemberDTO,
  TaskAgentDTO,
  TaskBoardDTO,
  TaskDetailDTO,
  TaskLabelDTO,
  TaskDTO,
  TaskPriority,
  TaskStatus,
} from '~~/shared/types'
import { boardPath } from '~~/shared/paths'

definePageMeta({ layout: 'server', middleware: ['auth', 'manage-tasks'] })

const session = useSessionStore()
const { serverId } = useServer()
const { can, canAnyProject } = useRoleGrants()
const isMobile = useIsMobile()
const { api } = useApi()
const qc = useQueryClient()
const toast = useToast()
const startingRun = ref(false)
async function runTask(task: TaskDetailDTO) {
  if (startingRun.value || !task.assigneeId) return
  startingRun.value = true
  try {
    let channelId = task.channelId || task.discussionChannelId
    if (!channelId) {
      const discussion = await api<{ channelId: string }>(`/api/tasks/${task.id}/discussion`, { method: 'POST' })
      channelId = discussion.channelId
      if (!channelId) throw new Error('The task discussion is not ready. Refresh the task before starting the agent.')
      void qc.invalidateQueries({ queryKey: ['task'] })
    }
    const result = await api<{ run: { id: string } }>('/api/agent-runs', { method: 'POST', body: {
      agentId: task.assigneeId, taskId: task.id, channelId,
      prompt: `${task.title}\n\n${task.description}`, idempotencyKey: crypto.randomUUID(),
    } })
    await navigateTo(`/runs/${result.run.id}`)
  } catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { startingRun.value = false }
}

async function runSelectedTask() {
  if (selectedTask.value && !taskRunProblem.value) await runTask(selectedTask.value)
}

const taskRunProblem = computed(() => {
  const task = selectedTask.value
  if (!task) return 'Choose a task to run.'
  if (task.archivedAt) return 'Restore this task before starting its agent.'
  if (taskDirty.value) return 'Save your task changes before starting the agent.'
  if (!task.channelId && !task.discussionChannelId && !can(Permission.writeTasks, task.projectId)) return 'Ask a task manager to open its discussion before starting the agent.'
  const agent = agents.value.find(item => item.id === task.assigneeId)
  if (agent?.status === 'paused') return 'Resume the assigned agent in Agents before starting this task.'
  if (!agent || agent.status !== 'active') return 'Assign an active agent to this task.'
  const member = membersQ.data.value?.members.find(item => item.user.id === task.assigneeId)
  if (!member || member.user.kind !== 'agent') return 'Assign an active agent to this task.'
  for (const [permission, label] of [[Permission.readTasks, 'Read tasks'], [Permission.executeTasks, 'Execute assigned tasks'], [Permission.sendMessages, 'Send messages']] as const) {
    if (member.role.permissions && !hasPermission(member.role.permissions, permission) && !(task.projectId && member.projectPolicies?.some(grant => grant.projectId === task.projectId && hasPermission(grant.permissions, permission)))) return `${member.user.displayName}’s role needs ${label}. Change the role in Server settings.`
  }
  if (task.projectId && member.role.permissions && !hasPermission(member.role.permissions, Permission.readProjects) && !member.projectPolicies?.some(grant => grant.projectId === task.projectId && hasPermission(grant.permissions, Permission.readProjects))) return `${member.user.displayName}’s role needs Read projects. Change the role in Server settings.`
  return ''
})
/** Board and the archived view live in the URL so the sidebar can link to them. */
const route = useRoute()
const nav = useNavActions()
const showArchived = computed({
  get: () => route.query.archived === '1',
  set: value => void navigateTo(boardPath(null, value)),
})
const selectedBoardId = computed({
  get: () => String(route.query.board || '') || null,
  set: value => void navigateTo(boardPath(value, showArchived.value)),
})
const selectedTaskId = computed({
  get: () => String(route.query.task || '') || null,
  set: value => void navigateTo({ query: { ...route.query, task: value || undefined } }),
})
const taskSearch = ref('')
const showBoardForm = ref(false)
const showTaskForm = ref(false)
const showLabels = ref(false)
const showConfirm = ref(false)
const saving = ref(false)
const draggedTaskId = ref<string | null>(null)
const confirmAction = shallowRef<null | (() => Promise<void>)>(null)
const confirmTitle = ref('')

const agentsQ = useQuery({
  queryKey: computed(() => ['agents', serverId.value]),
  queryFn: () => api<{ agents: TaskAgentDTO[] }>(`/api/servers/${serverId.value}/task-agents`),
  enabled: computed(() => Boolean(serverId.value)),
})
const environmentsQ = useQuery({
  queryKey: ['code-environments'], queryFn: () => api<{ environments: CodeEnvironment[] }>('/api/code-environments'), enabled: computed(() => canAnyProject(Permission.useComputer)),
})
const projectsQ = useQuery({ queryKey: computed(() => ['projects', serverId.value]), queryFn: () => api<{ projects: { id: string; name: string; archivedAt: string | null }[] }>(`/api/servers/${serverId.value}/projects`), enabled: computed(() => canAnyProject(Permission.readProjects)) })
const projectOptions = computed(() => [{ label: 'No project', value: null }, ...(projectsQ.data.value?.projects ?? []).filter(p => !p.archivedAt).map(p => ({ label: p.name, value: p.id }))])
const environmentOptions = computed(() => [{ label: 'No repository', value: null }, ...(environmentsQ.data.value?.environments ?? []).filter(item => item.enabled).map(item => ({ label: item.name, value: item.id }))])
const membersQ = useQuery({
  queryKey: computed(() => ['members', serverId.value]),
  queryFn: () => api<{ members: MemberDTO[] }>(`/api/servers/${serverId.value}/members`),
  enabled: computed(() => Boolean(serverId.value)),
})
const boardsQ = useQuery({
  queryKey: computed(() => ['boards', serverId.value, showArchived.value]),
  queryFn: () => api<{ boards: TaskBoardDTO[] }>(`/api/servers/${serverId.value}/boards`, { query: { archived: showArchived.value } }),
  enabled: computed(() => Boolean(serverId.value)),
})
const channelsQ = useQuery({
  queryKey: computed(() => ['channels', serverId.value]),
  queryFn: () => api<{ channels: ChannelDTO[] }>(`/api/servers/${serverId.value}/channels`),
  enabled: computed(() => Boolean(serverId.value)),
})
const taskQ = useQuery({
  queryKey: computed(() => ['task', selectedTaskId.value]),
  queryFn: () => api<{ task: TaskDetailDTO }>(`/api/tasks/${selectedTaskId.value}`),
  enabled: computed(() => Boolean(selectedTaskId.value)),
})

const allBoards = computed(() => boardsQ.data.value?.boards ?? [])
const boards = computed(() => showArchived.value
  ? allBoards.value.filter(board => Boolean(board.archivedAt) || board.tasks.some(task => Boolean(task.archivedAt)))
  : allBoards.value)
const activeBoard = computed(() => boards.value.find(board => board.id === selectedBoardId.value) ?? boards.value[0] ?? null)
const boardTasks = computed(() => {
  const board = activeBoard.value
  if (!board) return []
  const tasks = route.query.project ? board.tasks.filter(t => t.projectId === String(route.query.project)) : board.tasks
  if (!showArchived.value) return tasks
  return board.archivedAt ? tasks : tasks.filter(task => Boolean(task.archivedAt))
})
const activeTasks = computed(() => {
  const query = taskSearch.value.trim().toLocaleLowerCase().replace(/^#/u, '')
  if (!query) return boardTasks.value
  return boardTasks.value.filter(task => [String(task.number), task.title, task.description]
    .some(value => value.toLocaleLowerCase().includes(query)))
})
const agents = computed(() => agentsQ.data.value?.agents ?? [])
const channels = computed(() => (channelsQ.data.value?.channels ?? []).filter(channel => channel.type === 'text' && channel.visibility === 'server'))
const selectedTask = computed(() => taskQ.data.value?.task ?? null)

/** A board id that no longer resolves (deleted, archived away) falls back to the first one. */
watch([boards, selectedBoardId], ([value, id]) => {
  if (!id || !value.length) return
  if (!value.some(board => board.id === id)) selectedBoardId.value = value[0]?.id ?? null
}, { immediate: true })

watch(showArchived, () => {
  selectedTaskId.value = null
})

watch(() => nav.createBoardOpen.value, (open) => {
  if (!open) return
  nav.createBoardOpen.value = false
  openCreateBoard()
})

const columns: Array<{ status: TaskStatus; label: string }> = [
  { status: 'backlog', label: 'Backlog' },
  { status: 'ready', label: 'Ready' },
  { status: 'review', label: 'Review' },
  { status: 'done', label: 'Done' },
  { status: 'failed', label: 'Failed' },
]
const manualStatusOptions = columns.map(column => ({ label: column.label, value: column.status }))
const priorityOptions: Array<{ label: string; value: TaskPriority }> = [
  { label: 'Low', value: 'low' },
  { label: 'Normal', value: 'normal' },
  { label: 'High', value: 'high' },
  { label: 'Urgent', value: 'urgent' },
]
const labelColors = ['neutral', 'primary', 'info', 'success', 'warning', 'error'] as const
const labelColorOptions = [...labelColors]
const members = computed(() => membersQ.data.value?.members ?? [])
// Anyone active can own a task: people first, then agents that are not paused.
const assigneeOptions = computed(() => {
  const people = members.value
    .filter(member => member.user.kind !== 'agent')
    .map(member => ({ label: member.nickname || member.user.displayName, value: member.user.id as string | null, icon: 'i-ph-user' }))
  const activeAgents = agents.value
    .filter(agent => agent.status === 'active')
    .map(agent => ({ label: agent.displayName, value: agent.id as string | null, icon: 'i-ph-robot' }))
  return [
    { label: 'Unassigned', value: null as string | null },
    ...(people.length ? [{ type: 'label' as const, label: 'People' }, ...people] : []),
    ...(activeAgents.length ? [{ type: 'label' as const, label: 'Agents' }, ...activeAgents] : []),
  ]
})
const channelOptions = computed(() => [
  { label: 'Task discussion (default)', value: null },
  ...channels.value.map(channel => ({ label: `# ${channel.name}`, value: channel.id })),
])
const boardOptions = computed(() => allBoards.value.filter(board => !board.archivedAt).map(board => ({ label: board.name, value: board.id })))

type TaskForm = {
  title: string
  description: string
  priority: TaskPriority
  dueAt: string
  projectId: string | null
  environmentId: string | null
  assigneeId: string | null
  channelId: string | null
  labelIds: string[]
  dependencyIds: string[]
}

const newTask = reactive<TaskForm>({ title: '', description: '', priority: 'normal', dueAt: '', assigneeId: null, projectId: null, environmentId: null, channelId: null, labelIds: [], dependencyIds: [] })
const editTask = reactive<TaskForm & { boardId: string; status: TaskStatus }>({
  title: '', description: '', priority: 'normal', dueAt: '', assigneeId: null, projectId: null, environmentId: null, channelId: null, labelIds: [], dependencyIds: [], boardId: '', status: 'backlog',
})
const boardName = ref('')
const editingBoardId = ref<string | null>(null)
const labelName = ref('')
const labelColor = ref<(typeof labelColors)[number]>('neutral')
const editingLabelId = ref<string | null>(null)
const checklistTitle = ref('')
const fileInput = useTemplateRef<HTMLInputElement>('fileInput')

function fillEditTask(task: TaskDetailDTO | null) {
  if (!task) return
  Object.assign(editTask, {
    title: task.title,
    description: task.description,
    priority: task.priority,
    dueAt: toDateInput(task.dueAt),
    assigneeId: task.assigneeId,
    projectId: task.projectId ?? null,
    environmentId: task.environmentId ?? null,
    channelId: task.channelId,
    labelIds: task.labels.map(label => label.id),
    dependencyIds: [...task.dependencyIds],
    boardId: task.boardId,
    status: task.status,
  })
}
watch(selectedTask, fillEditTask, { immediate: true })

function sameIds(a: string[], b: string[]) {
  return a.length === b.length && a.every(id => b.includes(id))
}

/** Field edits wait for the save bar; checklist, files, and discussion save as they happen. */
const taskDirty = computed(() => {
  const task = selectedTask.value
  if (!task || task.archivedAt) return false
  return editTask.title !== task.title
    || editTask.description !== task.description
    || editTask.priority !== task.priority
    || editTask.dueAt !== toDateInput(task.dueAt)
    || editTask.assigneeId !== task.assigneeId
    || editTask.channelId !== task.channelId
    || editTask.projectId !== (task.projectId ?? null)
    || editTask.environmentId !== (task.environmentId ?? null)
    || editTask.boardId !== task.boardId
    || editTask.status !== task.status
    || !sameIds(editTask.labelIds, task.labels.map(label => label.id))
    || !sameIds(editTask.dependencyIds, task.dependencyIds)
})
const dependencyChoices = computed(() => allBoards.value
  .find(board => board.id === editTask.boardId)?.tasks
  .filter(task => task.id !== selectedTask.value?.id && !task.archivedAt) ?? [])

function tasksFor(status: TaskStatus) {
  return activeTasks.value.filter(task => task.status === status)
}

function taskLabel(task: Pick<TaskDTO, 'number' | 'title'>) {
  return `#${task.number} ${task.title}`
}

function assignee(id: string | null) {
  if (!id) return null
  const member = members.value.find(item => item.user.id === id)
  if (member) return { name: member.nickname || member.user.displayName, user: member.user }
  const agent = agents.value.find(item => item.id === id)
  return agent ? { name: agent.displayName, user: null } : null
}

function priorityColor(priority: TaskPriority) {
  return priority === 'urgent' ? 'error' : priority === 'high' ? 'warning' : priority === 'low' ? 'neutral' : 'primary'
}

function toDateInput(value: string | null) {
  if (!value) return ''
  const date = new Date(value)
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

function toIso(value: string) {
  return value ? new Date(value).toISOString() : null
}

function formatDate(value: string | null) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : ''
}

function toggleId(list: string[], id: string, selected: boolean) {
  const index = list.indexOf(id)
  if (selected && index === -1) list.push(id)
  if (!selected && index !== -1) list.splice(index, 1)
}

async function refresh(taskId: string | null = selectedTaskId.value) {
  await qc.invalidateQueries({ queryKey: ['boards'] })
  if (taskId) await qc.invalidateQueries({ queryKey: ['task', taskId] })
}

/**
 * Runs a change, then refreshes lists in the background: the dialog that made
 * the change can close as soon as the server confirms it.
 */
async function mutate(action: () => Promise<unknown>, success?: string) {
  saving.value = true
  try {
    await action()
    if (success) toast.add({ title: success, color: 'success' })
    void refresh()
    return true
  }
  catch (error) {
    toast.add({ title: errorMessage(error), color: 'error' })
    return false
  }
  finally {
    saving.value = false
  }
}

function openCreateBoard() {
  editingBoardId.value = null
  boardName.value = ''
  showBoardForm.value = true
}

function openRenameBoard() {
  if (!activeBoard.value) return
  editingBoardId.value = activeBoard.value.id
  boardName.value = activeBoard.value.name
  showBoardForm.value = true
}

async function saveBoard() {
  if (saving.value || !boardName.value.trim()) return
  const editing = editingBoardId.value
  const action = editing
    ? async () => { await api(`/api/boards/${editing}`, { method: 'PATCH', body: { name: boardName.value } }) }
    : async () => {
        const res = await api<{ board: TaskBoardDTO }>(`/api/servers/${serverId.value}/boards`, { method: 'POST', body: { name: boardName.value } })
        qc.setQueriesData<{ boards: TaskBoardDTO[] }>({ queryKey: ['boards', serverId.value, false] }, old => old ? { boards: [...old.boards, res.board] } : old)
        selectedBoardId.value = res.board.id
      }
  const ok = await mutate(action, editing ? 'Board renamed' : 'Board created')
  if (ok) showBoardForm.value = false
}

async function moveBoard(direction: -1 | 1) {
  const board = activeBoard.value
  if (!board || showArchived.value) return
  const ids = boards.value.map(item => item.id)
  const index = ids.indexOf(board.id)
  const target = index + direction
  if (target < 0 || target >= ids.length) return
  ;[ids[index], ids[target]] = [ids[target]!, ids[index]!]
  await mutate(() => api(`/api/servers/${serverId.value}/boards/reorder`, { method: 'PATCH', body: { boardIds: ids } }))
}

function askConfirm(title: string, action: () => Promise<void>) {
  confirmTitle.value = title
  confirmAction.value = action
  showConfirm.value = true
}

async function confirmMutation() {
  const action = confirmAction.value
  showConfirm.value = false
  if (action) await action()
  confirmAction.value = null
}

function archiveBoard() {
  const board = activeBoard.value
  if (!board) return
  askConfirm(board.archivedAt ? 'Restore board?' : 'Archive board?', async () => {
    await mutate(() => api(`/api/boards/${board.id}`, { method: 'PATCH', body: { archived: !board.archivedAt } }), board.archivedAt ? 'Board restored' : 'Board archived')
  })
}

function deleteBoard() {
  const board = activeBoard.value
  if (!board) return
  askConfirm(`Delete ${board.name} and every task?`, async () => {
    const ok = await mutate(() => api(`/api/boards/${board.id}`, { method: 'DELETE' }), 'Board deleted')
    if (ok) selectedBoardId.value = boards.value.find(board => board.id !== activeBoard.value?.id)?.id ?? null
  })
}

function openCreateTask() {
  Object.assign(newTask, { title: '', description: '', priority: 'normal', dueAt: '', assigneeId: null, projectId: null, environmentId: null, channelId: null, labelIds: [], dependencyIds: [] })
  newTask.projectId = String(route.query.project || '') || null
  showTaskForm.value = true
}

async function createTask(runAfter = false) {
  if (!activeBoard.value || !newTask.title.trim()) return
  const boardId = activeBoard.value.id
  let created: TaskDetailDTO | undefined
  const ok = await mutate(async () => {
    const res = await api<{ task: TaskDetailDTO }>(`/api/boards/${boardId}/tasks`, {
      method: 'POST',
      body: { ...newTask, dueAt: toIso(newTask.dueAt) },
    })
    created = res.task
    const { checklist: _checklist, attachments: _attachments, ...task } = res.task
    qc.setQueriesData<{ boards: TaskBoardDTO[] }>({ queryKey: ['boards', serverId.value, false] }, old => old
      ? { boards: old.boards.map(board => board.id === boardId ? { ...board, tasks: [...board.tasks, task] } : board) }
      : old)
  }, 'Task created')
  if (ok) {
    showTaskForm.value = false
    if (runAfter && created) await runTask(created)
  }
}

function openTask(task: TaskDTO) {
  selectedTaskId.value = String(task.number)
}

async function saveTask() {
  const task = selectedTask.value
  if (!task) return
  const key = selectedTaskId.value
  await mutate(async () => {
    const res = await api<{ task: TaskDetailDTO }>(`/api/tasks/${task.id}`, {
      method: 'PATCH',
      body: { ...editTask, dueAt: toIso(editTask.dueAt) },
    })
    // The saved task comes back with the response, so the save bar clears at once.
    qc.setQueryData(['task', key], { task: res.task })
  }, 'Task saved')
}

function changeEditBoard(value: string | number | undefined) {
  if (value === undefined || String(value) === editTask.boardId) return
  editTask.boardId = String(value)
  editTask.labelIds.splice(0)
  editTask.dependencyIds.splice(0)
}

async function setStatus(taskId: string, status: TaskStatus, position?: number) {
  await mutate(() => api(`/api/tasks/${taskId}`, { method: 'PATCH', body: { status, ...(position === undefined ? {} : { position }) } }))
}

async function dropTask(status: TaskStatus, beforeTaskId: string | null = null) {
  const taskId = draggedTaskId.value
  draggedTaskId.value = null
  const task = allBoards.value.flatMap(board => board.tasks).find(item => item.id === taskId)
  if (!taskId || !task || showArchived.value || !can(Permission.writeTasks, task.projectId)) return
  await mutate(() => api(`/api/boards/${activeBoard.value!.id}/tasks/reorder`, {
    method: 'PATCH',
    body: { taskId, status, beforeTaskId: beforeTaskId === taskId ? null : beforeTaskId },
  }))
}

function archiveTask() {
  const task = selectedTask.value
  if (!task) return
  askConfirm(task.archivedAt ? 'Restore task?' : 'Archive task?', async () => {
    const ok = await mutate(() => api(`/api/tasks/${task.id}`, { method: 'PATCH', body: { archived: !task.archivedAt } }), task.archivedAt ? 'Task restored' : 'Task archived')
    if (ok) selectedTaskId.value = null
  })
}

function deleteTask() {
  const task = selectedTask.value
  if (!task) return
  askConfirm(`Delete ${task.title}?`, async () => {
    const ok = await mutate(() => api(`/api/tasks/${task.id}`, { method: 'DELETE' }), 'Task deleted')
    if (ok) selectedTaskId.value = null
  })
}

function openLabels() {
  editingLabelId.value = null
  labelName.value = ''
  labelColor.value = 'neutral'
  showLabels.value = true
}

function editLabel(label: TaskLabelDTO) {
  editingLabelId.value = label.id
  labelName.value = label.name
  labelColor.value = label.color as (typeof labelColors)[number]
}

async function saveLabel() {
  if (!activeBoard.value || !labelName.value.trim()) return
  const id = editingLabelId.value
  const ok = await mutate(() => id
    ? api(`/api/task-labels/${id}`, { method: 'PATCH', body: { name: labelName.value, color: labelColor.value } })
    : api(`/api/boards/${activeBoard.value!.id}/labels`, { method: 'POST', body: { name: labelName.value, color: labelColor.value } }), id ? 'Label saved' : 'Label created')
  if (ok) {
    editingLabelId.value = null
    labelName.value = ''
    labelColor.value = 'neutral'
  }
}

async function deleteLabel(id: string) {
  await mutate(() => api(`/api/task-labels/${id}`, { method: 'DELETE' }), 'Label deleted')
}

async function addChecklistItem() {
  const task = selectedTask.value
  if (!task || !checklistTitle.value.trim()) return
  const title = checklistTitle.value
  checklistTitle.value = ''
  await mutate(() => api(`/api/tasks/${task.id}/checklist`, { method: 'POST', body: { title } }))
}

async function updateChecklistItem(id: string, completed: boolean) {
  await mutate(() => api(`/api/task-checklist/${id}`, { method: 'PATCH', body: { completed } }))
}

async function deleteChecklistItem(id: string) {
  await mutate(() => api(`/api/task-checklist/${id}`, { method: 'DELETE' }))
}

/** Picking a file attaches it right away. */
async function uploadAttachment(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  const task = selectedTask.value
  input.value = ''
  if (!task || !file) return
  const form = new FormData()
  form.append('file', file)
  await mutate(() => api(`/api/tasks/${task.id}/attachments`, { method: 'POST', body: form }), 'File attached')
}

async function deleteAttachment(id: string) {
  await mutate(() => api(`/api/task-attachments/${id}`, { method: 'DELETE' }), 'Attachment deleted')
}

const boardMenu = computed(() => [[
  { label: 'Rename', icon: 'i-ph-pencil-simple', onSelect: openRenameBoard },
  { label: 'Labels', icon: 'i-ph-tag', onSelect: openLabels },
  { label: 'Move left', icon: 'i-ph-arrow-left', disabled: showArchived.value || boards.value[0]?.id === activeBoard.value?.id, onSelect: () => moveBoard(-1) },
  { label: 'Move right', icon: 'i-ph-arrow-right', disabled: showArchived.value || boards.value.at(-1)?.id === activeBoard.value?.id, onSelect: () => moveBoard(1) },
], [
  { label: activeBoard.value?.archivedAt ? 'Restore' : 'Archive', icon: 'i-ph-archive', onSelect: archiveBoard },
  { label: 'Delete', icon: 'i-ph-trash', color: 'error' as const, onSelect: deleteBoard },
]])
</script>

<template>
  <div class="flex h-full min-h-0 min-w-0 flex-col">
    <main class="flex-1 min-w-0 min-h-0 flex flex-col">
      <LayoutPageHeader icon="i-ph-kanban" :title="activeBoard?.name || 'Tasks'" :loading="boardsQ.isPending.value">
        <template #meta>
          <UBadge v-if="showArchived" label="Archived" color="neutral" variant="subtle" size="sm" />
        </template>
        <template #actions>
          <UInput v-if="activeBoard" v-model="taskSearch" icon="i-ph-magnifying-glass" placeholder="Search tasks" aria-label="Search tasks" class="w-28 sm:w-44" />
          <UDropdownMenu v-if="activeBoard && can(Permission.manageTasks)" :items="boardMenu">
            <UButton color="neutral" variant="ghost" icon="i-ph-dots-three" aria-label="Board actions" />
          </UDropdownMenu>
          <UButton v-if="!showArchived && activeBoard && (can(Permission.writeTasks) || (route.query.project && can(Permission.writeTasks, String(route.query.project))))" icon="i-ph-plus" :label="isMobile ? undefined : 'Task'" aria-label="New task" @click="openCreateTask" />
        </template>
      </LayoutPageHeader>

      <LayoutSkeleton v-if="boardsQ.isPending.value" variant="board" />
      <LayoutLoadError v-else-if="boardsQ.error.value" message="Task boards did not load." :retry="boardsQ.refetch" />
      <LayoutEmptyState v-else-if="!activeBoard && showArchived" icon="i-ph-archive" title="Nothing archived" description="Boards you archive show up here." />
      <LayoutEmptyState v-else-if="!activeBoard" icon="i-ph-kanban" title="No boards yet" description="A board collects the tasks for one team or project, in columns from to-do to done.">
        <UButton v-if="can(Permission.manageTasks)" icon="i-ph-plus" label="Create first board" @click="openCreateBoard" />
      </LayoutEmptyState>
      <div v-else class="flex-1 min-h-0 overflow-auto p-4">
        <div class="grid grid-flow-col auto-cols-[minmax(260px,1fr)] gap-3 min-w-max h-full items-start">
          <section
            v-for="column in columns"
            :key="column.status"
            class="w-[280px] rounded-xl bg-muted p-2"
            @dragover.prevent
            @drop="dropTask(column.status)"
          >
            <div class="h-8 px-1 flex items-center gap-2 text-xs font-semibold text-muted">
              <span>{{ column.label }}</span><span>{{ tasksFor(column.status).length }}</span>
            </div>
            <div class="space-y-2 min-h-10">
              <article
                v-for="task in tasksFor(column.status)"
                :key="task.id"
                class="df-panel rounded-lg p-3 space-y-2 cursor-pointer"
                :draggable="!showArchived && can(Permission.writeTasks, task.projectId)"
                @dragstart="draggedTaskId = task.id"
                @dragend="draggedTaskId = null"
                @dragover.prevent
                @drop.stop="dropTask(column.status, task.id)"
                @click="openTask(task)"
              >
                <div class="flex items-start gap-2">
                  <div class="font-medium text-sm flex-1 min-w-0">
                    <span class="mr-1 text-muted">#{{ task.number }}</span>{{ task.title }}
                  </div>
                  <UBadge v-if="task.priority !== 'normal'" :color="priorityColor(task.priority)" variant="subtle" size="xs">{{ task.priority }}</UBadge>
                </div>
                <p v-if="task.description" class="text-xs text-muted line-clamp-3">{{ task.description }}</p>
                <div v-if="task.labels.length" class="flex flex-wrap gap-1">
                  <UBadge v-for="label in task.labels" :key="label.id" :color="label.color as 'neutral'" variant="subtle" size="xs">{{ label.name }}</UBadge>
                </div>
                <div class="flex items-center gap-2 text-[11px] text-muted">
                  <span v-if="assignee(task.assigneeId)" class="flex min-w-0 items-center gap-1.5">
                    <UserAvatar v-if="assignee(task.assigneeId)?.user" :user="assignee(task.assigneeId)!.user!" size="3xs" />
                    <UIcon v-else name="i-ph-robot" class="size-3.5" />
                    <span class="truncate">{{ assignee(task.assigneeId)?.name }}</span>
                  </span>
                  <span v-else class="text-dimmed">Unassigned</span>
                  <span v-if="task.checklistTotal" class="ml-auto">{{ task.checklistCompleted }}/{{ task.checklistTotal }}</span>
                  <UIcon v-if="task.attachmentCount" name="i-ph-paperclip" class="size-3.5" />
                </div>
                <div v-if="task.dueAt" class="text-[11px] text-muted">{{ formatDate(task.dueAt) }}</div>
                <UAlert v-if="task.lastError" color="error" :description="task.lastError" />
                <p v-if="task.factoryState" class="text-xs text-muted">Workspace: {{ task.factoryState }}</p>
                <div v-if="task.resultSummary" class="text-xs border-t border-default pt-2 line-clamp-3">{{ task.resultSummary }}</div>
                <div v-if="!showArchived && can(Permission.writeTasks, task.projectId)" class="flex items-center gap-1 pt-1" @click.stop>
                  <USelect
                    :model-value="task.status"
                    :items="manualStatusOptions"
                    size="xs"
                    class="ml-auto w-24"
                    @update:model-value="value => setStatus(task.id, value as TaskStatus)"
                  />
                </div>
              </article>
            </div>
          </section>
        </div>
      </div>
    </main>

    <UModal v-model:open="showBoardForm" :title="editingBoardId ? 'Rename board' : 'Create board'">
      <template #body>
        <UFormField label="Name"><UInput v-model="boardName" autofocus class="w-full" @keyup.enter="saveBoard" /></UFormField>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" label="Cancel" @click="showBoardForm = false" />
        <UButton label="Save" :loading="saving" :disabled="!boardName.trim()" @click="saveBoard" />
      </template>
    </UModal>

    <UModal v-model:open="showTaskForm" title="Create task" :ui="{ content: 'sm:max-w-2xl' }">
      <template #body>
        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField label="Title" class="sm:col-span-2"><UInput v-model="newTask.title" autofocus class="w-full" @keyup.enter="createTask(false)" /></UFormField>
          <UFormField label="Description" class="sm:col-span-2"><UTextarea v-model="newTask.description" :rows="5" class="w-full" /></UFormField>
          <UFormField label="Assignee"><USelect v-model="newTask.assigneeId" :items="assigneeOptions" class="w-full" /></UFormField>
          <UFormField v-if="canAnyProject(Permission.readProjects)" label="Project"><USelect v-model="newTask.projectId" :items="projectOptions" class="w-full" /></UFormField>
          <UFormField v-if="can(Permission.useComputer, newTask.projectId)" label="Repository environment" help="Uses a dedicated branch in the repository, or an optional fork."><USelect v-model="newTask.environmentId" :items="environmentOptions" class="w-full" /></UFormField>
          <p v-if="agents.some(agent => agent.id === newTask.assigneeId)" class="text-sm text-muted sm:col-span-2">Assignment does not start a run. Choose Create and run to start immediately, or run it from the task later.</p>
          <UFormField label="Report channel"><USelect v-model="newTask.channelId" :items="channelOptions" class="w-full" /></UFormField>
          <UFormField label="Priority"><USelect v-model="newTask.priority" :items="priorityOptions" class="w-full" /></UFormField>
          <UFormField label="Due"><UInput v-model="newTask.dueAt" type="datetime-local" class="w-full" /></UFormField>
          <div v-if="activeBoard?.labels.length" class="sm:col-span-2">
            <div class="text-sm font-medium mb-2">Labels</div>
            <div class="flex flex-wrap gap-3">
              <UCheckbox v-for="label in activeBoard.labels" :key="label.id" :model-value="newTask.labelIds.includes(label.id)" :label="label.name" @update:model-value="value => toggleId(newTask.labelIds, label.id, Boolean(value))" />
            </div>
          </div>
          <div v-if="boardTasks.length" class="sm:col-span-2">
            <div class="text-sm font-medium mb-2">Dependencies</div>
            <div class="max-h-32 overflow-y-auto space-y-1">
              <UCheckbox v-for="task in boardTasks" :key="task.id" :model-value="newTask.dependencyIds.includes(task.id)" :label="taskLabel(task)" @update:model-value="value => toggleId(newTask.dependencyIds, task.id, Boolean(value))" />
            </div>
          </div>
        </div>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" label="Cancel" @click="showTaskForm = false" />
        <UButton v-if="can(Permission.executeTasks, newTask.projectId) && can(Permission.useAgents, newTask.projectId) && agents.some(agent => agent.id === newTask.assigneeId && agent.status === 'active')" label="Create and run" :loading="saving || startingRun" :disabled="!newTask.title.trim()" @click="createTask(true)" />
        <UButton label="Create task" :loading="saving" :disabled="!newTask.title.trim()" @click="createTask(false)" />
      </template>
    </UModal>

    <UModal v-model:open="showLabels" title="Labels">
      <template #body>
        <div class="space-y-4">
          <div class="flex gap-2">
            <UInput v-model="labelName" placeholder="Label" class="flex-1" @keyup.enter="saveLabel" />
            <USelect v-model="labelColor" :items="labelColorOptions" class="w-32" />
            <UButton :label="editingLabelId ? 'Save' : 'Add'" :loading="saving" :disabled="!labelName.trim()" @click="saveLabel" />
          </div>
          <div class="divide-y divide-default">
            <div v-for="label in activeBoard?.labels ?? []" :key="label.id" class="py-2 flex items-center gap-2">
              <UBadge :color="label.color as 'neutral'" variant="subtle">{{ label.name }}</UBadge>
              <UButton class="ml-auto" color="neutral" variant="ghost" icon="i-ph-pencil-simple" aria-label="Edit label" @click="editLabel(label)" />
              <UButton color="error" variant="ghost" icon="i-ph-trash" aria-label="Delete label" @click="deleteLabel(label.id)" />
            </div>
          </div>
        </div>
      </template>
    </UModal>

    <USlideover :open="Boolean(selectedTaskId)" :title="selectedTask ? taskLabel(selectedTask) : 'Task'" :ui="{ content: 'w-full max-w-2xl' }" @update:open="value => { if (!value) selectedTaskId = null }">
      <template #body>
        <section v-if="selectedTask && can(Permission.executeTasks, selectedTask.projectId) && can(Permission.useAgents, selectedTask.projectId)" class="mb-6 space-y-2 border-b border-default pb-4" aria-label="Agent task execution">
          <span :title="taskRunProblem || undefined"><UButton label="Run assigned agent" icon="i-ph-play" :loading="startingRun" :disabled="Boolean(taskRunProblem)" :aria-describedby="taskRunProblem ? 'task-run-problem' : undefined" @click="runSelectedTask" /></span>
          <p v-if="taskRunProblem" id="task-run-problem" class="text-sm text-muted" role="status">{{ taskRunProblem }}</p>
          <p v-else class="text-sm text-muted">Assignment does not start a run. Use Run assigned agent when you are ready.</p>
          <p v-if="!selectedTask.channelId" class="text-xs text-muted">The agent posts its report in this task’s discussion. A separate report channel is optional.</p>
        </section>
        <LayoutSkeleton v-if="taskQ.isPending.value" variant="form" />
        <LayoutLoadError v-else-if="taskQ.error.value" message="This task did not load." :retry="taskQ.refetch" />
        <fieldset v-else-if="selectedTask" :disabled="!can(Permission.writeTasks, selectedTask.projectId)" class="space-y-8 min-w-0">
          <section class="grid gap-4 sm:grid-cols-2">
            <UFormField label="Title" class="sm:col-span-2"><UInput v-model="editTask.title" class="w-full" :disabled="Boolean(selectedTask.archivedAt)" /></UFormField>
            <UFormField label="Description" class="sm:col-span-2"><UTextarea v-model="editTask.description" :rows="5" autoresize class="w-full" :disabled="Boolean(selectedTask.archivedAt)" /></UFormField>
            <UFormField label="Status"><USelect v-model="editTask.status" :items="manualStatusOptions" class="w-full" /></UFormField>
            <UFormField label="Assignee"><USelect v-model="editTask.assigneeId" :items="assigneeOptions" class="w-full" /></UFormField>
          <UFormField v-if="canAnyProject(Permission.readProjects)" label="Project"><USelect v-model="editTask.projectId" :items="projectOptions" class="w-full" /></UFormField>
          <UFormField v-if="can(Permission.useComputer, editTask.projectId)" label="Repository environment" help="Uses a dedicated branch in the repository, or an optional fork."><USelect v-model="editTask.environmentId" :items="environmentOptions" class="w-full" /></UFormField>
            <UFormField label="Priority"><USelect v-model="editTask.priority" :items="priorityOptions" class="w-full" /></UFormField>
            <UFormField label="Due"><UInput v-model="editTask.dueAt" type="datetime-local" class="w-full" /></UFormField>
            <UFormField label="Board"><USelect :model-value="editTask.boardId" :items="boardOptions" class="w-full" @update:model-value="changeEditBoard" /></UFormField>
            <UFormField label="Report channel" help="Optional. Without a separate channel, the agent reports in this task’s discussion."><USelect v-model="editTask.channelId" :items="channelOptions" class="w-full" /></UFormField>
          </section>

          <section v-if="allBoards.find(board => board.id === editTask.boardId)?.labels.length">
            <div class="mb-2 text-sm font-medium">Labels</div>
            <div class="flex flex-wrap gap-3">
              <UCheckbox
                v-for="label in allBoards.find(board => board.id === editTask.boardId)?.labels ?? []"
                :key="label.id"
                :model-value="editTask.labelIds.includes(label.id)"
                :label="label.name"
                @update:model-value="value => toggleId(editTask.labelIds, label.id, Boolean(value))"
              />
            </div>
          </section>

          <section v-if="dependencyChoices.length">
            <div class="mb-1 text-sm font-medium">Depends on</div>
            <p class="mb-2 text-xs text-muted">Tasks on this board that must be finished first.</p>
            <div class="max-h-36 space-y-1 overflow-y-auto">
              <UCheckbox
                v-for="task in dependencyChoices"
                :key="task.id"
                :model-value="editTask.dependencyIds.includes(task.id)"
                :label="taskLabel(task)"
                @update:model-value="value => toggleId(editTask.dependencyIds, task.id, Boolean(value))"
              />
            </div>
          </section>

          <section>
            <div class="mb-2 text-sm font-medium">Checklist</div>
            <div class="space-y-2">
              <div v-for="item in selectedTask.checklist" :key="item.id" class="flex items-center gap-2">
                <UCheckbox :model-value="item.completed" :label="item.title" @update:model-value="value => updateChecklistItem(item.id, Boolean(value))" />
                <UButton class="ml-auto" color="neutral" variant="ghost" size="xs" icon="i-ph-x" aria-label="Remove checklist item" @click="deleteChecklistItem(item.id)" />
              </div>
              <UInput v-model="checklistTitle" placeholder="Add an item and press Enter" class="w-full" @keyup.enter="addChecklistItem" />
            </div>
          </section>

          <section>
            <div class="mb-2 flex items-center justify-between gap-2">
              <span class="text-sm font-medium">Files</span>
              <UButton size="xs" color="neutral" variant="soft" icon="i-ph-paperclip" label="Attach file" :disabled="(session.health?.bindings.r2 === false && !session.health?.bindings.kv)" :loading="saving" @click="fileInput?.click()" />
              <input ref="fileInput" type="file" class="hidden" @change="uploadAttachment">
            </div>
            <p v-if="!selectedTask.attachments.length" class="text-sm text-muted">No files yet.</p>
            <div v-else class="space-y-1">
              <div v-for="attachment in selectedTask.attachments" :key="attachment.id" class="flex items-center gap-2 text-sm">
                <UIcon name="i-ph-paperclip" class="size-4 shrink-0 text-muted" />
                <ULink :to="attachment.url" target="_blank" class="truncate">{{ attachment.filename }}</ULink>
                <UButton class="ml-auto" color="neutral" variant="ghost" size="xs" icon="i-ph-trash" aria-label="Delete file" @click="deleteAttachment(attachment.id)" />
              </div>
            </div>
          </section>

          <p v-if="selectedTask.factoryState" class="text-sm">Workspace: {{ selectedTask.factoryState }}</p>
          <section v-if="selectedTask.resultSummary || selectedTask.resultDetails">
            <div class="mb-2 text-sm font-medium">Result</div>
            <div class="space-y-2 rounded-lg border border-default p-3 text-sm">
              <ChatMarkdownView v-if="selectedTask.resultSummary && !selectedTask.resultDetails" :content="selectedTask.resultSummary" />
              <ChatMarkdownView v-if="selectedTask.resultDetails" :content="selectedTask.resultDetails" class="text-xs text-muted" />
            </div>
          </section>



          <div v-if="can(Permission.manageTasks)" class="flex items-center gap-2 border-t border-default pt-4">
            <UButton color="neutral" variant="ghost" size="sm" :icon="selectedTask.archivedAt ? 'i-ph-arrow-counter-clockwise' : 'i-ph-archive'" :label="selectedTask.archivedAt ? 'Restore task' : 'Archive task'" @click="archiveTask" />
            <UButton color="error" variant="ghost" size="sm" icon="i-ph-trash" label="Delete task" @click="deleteTask" />
          </div>

          <LayoutSaveBar v-if="can(Permission.writeTasks, selectedTask?.projectId)" :dirty="taskDirty" :saving="saving" :disabled="!editTask.title.trim()" @save="saveTask" @reset="fillEditTask(selectedTask)" />
        </fieldset>

        <TasksDiscussion
          v-if="selectedTask"
            :can-create="can(Permission.writeTasks, selectedTask.projectId)"
            :task-id="selectedTask.id"
            :channel-id="selectedTask.discussionChannelId"
            :server-id="serverId"
            :members="members"
          />

      </template>
    </USlideover>

    <UModal v-model:open="showConfirm" :title="confirmTitle">
      <template #footer>
        <UButton color="neutral" variant="ghost" label="Cancel" @click="showConfirm = false" />
        <UButton color="error" label="Confirm" :loading="saving" @click="confirmMutation" />
      </template>
    </UModal>
  </div>
</template>
