<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { displayAgentPrompt } from '~~/shared/agent-images'
import { runStatusColor } from '~~/shared/agent-run-status'
import { boardPath } from '~~/shared/paths'
import { Permission, hasPermission } from '~~/shared/permissions'
import type { Project, ProjectRepository } from '~~/shared/projects'
import type { TaskBoardDTO } from '~~/shared/types'
import type { RunListPage } from '~~/server/utils/agent-run-list'
definePageMeta({ layout: 'server', middleware: ['auth'] })
const route = useRoute(), cache = useQueryClient()
const { api } = useApi(), { serverId } = useServer(), { can } = useRoleGrants()
const toast = useToast(), busy = ref(false), repositoryOpen = ref(false), connectOpen = ref(false), inviteOpen = ref(false)
const selected = computed(() => String(route.params.id))
const detail = useQuery({ queryKey: computed(() => ['project', selected.value]), queryFn: () => api<{ project: Project; repositories: ProjectRepository[]; permissions: number }>(`/api/projects/${selected.value}`) })
const environments = useQuery({ queryKey: ['code-environments'], queryFn: () => api<{ environments: { id: string; name: string; sourceRepo: string; sourceRepoId: number; baseBranch: string }[] }>('/api/code-environments'), enabled: computed(() => can(Permission.manageProjects)) })
const project = computed(() => detail.data.value?.project)
const hasOwnAccess = computed(() => Boolean(project.value))
const readsTasks = computed(() => hasPermission(detail.data.value?.permissions ?? 0, Permission.readTasks))
const boardsQ = useQuery({
  queryKey: computed(() => ['boards', serverId.value, false]),
  queryFn: () => api<{ boards: TaskBoardDTO[] }>(`/api/servers/${serverId.value}/boards`, { query: { archived: false } }),
  enabled: computed(() => Boolean(serverId.value) && readsTasks.value),
})
const tasksHere = computed(() => (boardsQ.data.value?.boards ?? []).flatMap(board => board.tasks.filter(task => task.projectId === selected.value && !task.archivedAt)))
// Run content stays private to whoever started it, so this lists the viewer's own Runs here.
const runsQ = useQuery({
  queryKey: computed(() => ['project-runs', selected.value]),
  queryFn: () => api<RunListPage>('/api/agent-runs', { query: { projectId: selected.value } }),
  enabled: computed(() => Boolean(project.value)),
})
const runs = computed(() => (runsQ.data.value?.runs ?? []).slice(0, 5))
const environmentId = ref<string | null>(null)
const provider = ref('github'), host = ref('https://github.com'), slug = ref(''), externalId = ref(''), branch = ref('main')
watch(environmentId, id => { const e = environments.data.value?.environments.find(e => e.id === id); if (e) { provider.value = 'github'; host.value = 'https://github.com'; slug.value = e.sourceRepo; externalId.value = String(e.sourceRepoId); branch.value = e.baseBranch } else externalId.value = '' })
async function attach() {
 busy.value = true
 try { await api(`/api/projects/${selected.value}/repositories`, { method: 'POST', body: { provider: provider.value, host: host.value, slug: slug.value, externalId: externalId.value || undefined, defaultBranch: branch.value, environmentId: environmentId.value || null } }); slug.value = ''; externalId.value = ''; repositoryOpen.value = false; await detail.refetch() }
 catch (e) { toast.add({ title: errorMessage(e), color: 'error' }) } finally { busy.value = false }
}
async function archive() {
 if (!detail.data.value) return
 busy.value = true
 try { await api(`/api/projects/${selected.value}`, { method: 'PATCH', body: { version: detail.data.value.project.version, archived: !detail.data.value.project.archivedAt } }); await detail.refetch(); await cache.invalidateQueries({ queryKey: ['projects', serverId.value] }) }
 catch (e) { toast.add({ title: errorMessage(e), color: 'error' }) } finally { busy.value = false }
}
async function remove(id: string) {
 busy.value = true
 try { await api(`/api/projects/${selected.value}/repositories/${id}`, { method: 'DELETE' }); await detail.refetch() }
 catch (e) { toast.add({ title: errorMessage(e), color: 'error' }) } finally { busy.value = false }
}
</script>
<template>
 <div class="flex h-full min-h-0 min-w-0 flex-col">
  <LayoutPageHeader :crumbs="[{ label: 'Factory', to: '/projects' }, { label: project?.name || 'Project' }]" icon="i-ph-folder-simple" />
  <main class="mx-auto w-full max-w-5xl flex-1 space-y-6 overflow-auto p-4 sm:p-8">
   <LayoutSkeleton v-if="detail.isPending.value" variant="rows" :rows="3" />
   <LayoutLoadError v-else-if="detail.error.value" message="Project did not load." :retry="detail.refetch" />
   <section v-else-if="detail.data.value" class="space-y-8">
    <div class="space-y-3">
     <div class="flex flex-wrap items-center gap-2">
      <UBadge v-if="detail.data.value.project.archivedAt" label="Archived" color="neutral" variant="subtle" />
      <UButton v-if="hasOwnAccess && can(Permission.invite) && can(Permission.manageRoles) && can(Permission.manageProjects, selected) && !detail.data.value.project.archivedAt" label="Invite someone" icon="i-ph-user-plus" color="neutral" variant="outline" class="ms-auto" @click="inviteOpen = true" />
      <UButton v-if="can(Permission.manageProjects)" :label="detail.data.value.project.archivedAt ? 'Restore project' : 'Archive project'" color="neutral" variant="outline" :class="hasOwnAccess && can(Permission.invite) && can(Permission.manageRoles) ? '' : 'ms-auto'" :loading="busy" @click="archive" />
     </div>
     <p v-if="detail.data.value.project.description" class="whitespace-pre-wrap text-sm text-muted">{{ detail.data.value.project.description }}</p>
    </div>
    <TasksInviteModal v-if="hasOwnAccess" v-model:open="inviteOpen" :project-id="selected" :project-name="detail.data.value.project.name" />

    <section v-if="readsTasks" class="space-y-3" aria-labelledby="project-tasks">
     <h2 id="project-tasks" class="font-medium">Tasks</h2>
     <LayoutSkeleton v-if="boardsQ.isPending.value" variant="rows" :rows="2" />
     <LayoutLoadError v-else-if="boardsQ.error.value" message="Tasks did not load." :retry="boardsQ.refetch" />
     <p v-else-if="!tasksHere.length" class="text-sm text-muted">No tasks in this project yet. Choose this Project on a Task to work on it here.</p>
     <ul v-else class="divide-y divide-default rounded-lg border border-default">
      <li v-for="task in tasksHere" :key="task.id">
       <NuxtLink :to="`${boardPath(task.boardId)}&task=${encodeURIComponent(task.id)}`" class="flex items-center gap-2 p-3 hover:bg-elevated/60">
        <span class="shrink-0 text-xs tabular-nums text-muted">#{{ task.number }}</span>
        <span class="min-w-0 flex-1 truncate text-sm font-medium text-highlighted">{{ task.title }}</span>
       </NuxtLink>
      </li>
     </ul>
    </section>

    <section class="space-y-3" aria-labelledby="project-runs">
     <div class="flex items-center justify-between gap-3"><h2 id="project-runs" class="font-medium">Your runs here</h2><UButton to="/runs" label="All runs" color="neutral" variant="ghost" size="sm" trailing-icon="i-ph-caret-right" /></div>
     <LayoutSkeleton v-if="runsQ.isPending.value" variant="rows" :rows="2" />
     <LayoutLoadError v-else-if="runsQ.error.value" message="Runs did not load." :retry="runsQ.refetch" />
     <p v-else-if="!runs.length" class="text-sm text-muted">Runs you start on this project's tasks appear here.</p>
     <ul v-else class="divide-y divide-default rounded-lg border border-default">
      <li v-for="run in runs" :key="run.id">
       <NuxtLink :to="`/runs/${run.id}`" class="block px-4 py-3 hover:bg-elevated/60">
        <div class="flex items-center gap-2"><span class="min-w-0 flex-1 truncate text-sm font-medium text-highlighted">{{ run.agentName }}<span v-if="run.taskNumber" class="font-normal text-muted"> · Task #{{ run.taskNumber }}</span></span><UBadge :label="run.status" :color="runStatusColor(run.status)" variant="subtle" size="sm" /></div>
        <p class="mt-1 line-clamp-1 text-sm text-muted">{{ displayAgentPrompt(run.prompt) }}</p>
       </NuxtLink>
      </li>
     </ul>
    </section>

    <ProjectsAccess v-if="hasOwnAccess" :key="selected" :project-id="selected" />
    <section v-if="hasOwnAccess" class="space-y-4" aria-label="Repositories">
    <div class="flex flex-wrap items-center justify-between gap-3"><h2 class="font-medium">Repositories</h2><div v-if="can(Permission.manageProjects) && !detail.data.value.project.archivedAt" class="flex flex-wrap gap-2"><UButton label="Add reference only" color="neutral" variant="ghost" @click="repositoryOpen = true" /><UButton v-if="can(Permission.manageServer)" label="Connect repository" icon="i-ph-git-branch" @click="connectOpen = true" /></div></div>
    <ProjectsConnectRepository v-model:open="connectOpen" :project-id="selected" @connected="detail.refetch()" />
    <p class="text-sm text-muted">A connected repository is one agents can work on: they publish branches to it for review, as pull requests on GitHub or Gitea, or inside L4 for a repository that lives here. A reference only names a repository and enables nothing.</p>
    <div v-for="r in detail.data.value.repositories" :key="r.id" class="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded border border-default p-3">
     <div class="min-w-0"><p class="break-all font-medium">{{ r.slug }}</p><p class="break-all text-xs text-muted">{{ r.provider === 'artifacts' ? 'In L4' : r.provider }} · {{ r.host }} · {{ r.defaultBranch }}</p><p class="text-xs text-muted">{{ r.provider === 'artifacts' ? 'Lives in this Server; detaching keeps the repository and its history' : r.environmentId ? 'Linked to Git execution configuration' : 'Reference only; execution not connected' }}</p></div>
     <UButton v-if="can(Permission.manageProjects)" :label="r.environmentId ? 'Detach repository' : 'Detach reference'" color="neutral" variant="ghost" :loading="busy" @click="remove(r.id)" />
    </div>
    <ProjectsReleases v-if="detail.data.value.repositories.some(r => r.provider === 'artifacts')" :key="`releases-${selected}`" :project-id="selected" :archived="Boolean(detail.data.value.project.archivedAt)" />
    <UModal v-model:open="repositoryOpen" title="Attach repository" description="Connect a repository reference to this project."><template #body><form class="space-y-4" @submit.prevent="attach">
     <h3 class="font-medium">Attach repository reference</h3>
     <UFormField label="Git provider"><USelect v-model="provider" :items="['github', 'gitlab', 'gitea', 'cursor']" class="w-full" /></UFormField>
     <UFormField label="Provider origin"><UInput v-model="host" placeholder="https://github.com" class="w-full" /></UFormField>
     <UFormField label="Repository path"><UInput v-model="slug" placeholder="organization/repository" class="w-full" /></UFormField>
     <UFormField label="Default branch"><UInput v-model="branch" class="w-full" /></UFormField>
     <UFormField label="Coding environment" help="Configure GitHub access in Server settings → Git, then link the matching configuration. Other providers are references until their execution adapter is available."><USelect v-model="environmentId" :items="[{ label: 'Reference only', value: null }, ...(environments.data.value?.environments ?? []).map(e => ({ label: e.name + ' · ' + e.sourceRepo, value: e.id }))]" class="w-full" /></UFormField>
     <UButton type="submit" label="Attach reference" :disabled="!slug || !host" :loading="busy" />
    </form></template></UModal>
    <ProjectsGitFlow :key="`git-flow-${selected}`" :project-id="selected" :archived="Boolean(detail.data.value.project.archivedAt)" />
    <ProjectsCompute :key="`compute-${selected}`" :project-id="selected" :archived="Boolean(detail.data.value.project.archivedAt)" />
    <ProjectsNetwork :key="`network-${selected}`" :project-id="selected" :archived="Boolean(detail.data.value.project.archivedAt)" />
    <ProjectsSecrets :key="`secrets-${selected}`" :project-id="selected" :archived="Boolean(detail.data.value.project.archivedAt)" />
    </section>
   </section>
  </main>
 </div>
</template>
