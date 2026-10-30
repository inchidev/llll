<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { displayAgentPrompt } from '~~/shared/agent-images'
import { runStatusColor } from '~~/shared/agent-run-status'
import { Permission } from '~~/shared/permissions'
import type { Project } from '~~/shared/projects'
import type { RunListPage } from '~~/server/utils/agent-run-list'
definePageMeta({ layout: 'server', middleware: ['auth'] })
const { api } = useApi(), { serverId } = useServer(), { can } = useRoleGrants(), nav = useNavActions()
const search = ref(''), showArchived = ref(false)
const projects = useQuery({ queryKey: computed(() => ['projects', serverId.value]), queryFn: () => api<{ projects: Project[] }>(`/api/servers/${serverId.value}/projects`) })
const visible = computed(() => (projects.data.value?.projects ?? [])
  .filter(p => showArchived.value || !p.archivedAt)
  .filter(p => p.name.toLowerCase().includes(search.value.toLowerCase())))
const archivedCount = computed(() => (projects.data.value?.projects ?? []).filter(p => p.archivedAt).length)
// Runs this person started; the full list with filters is in Runs.
const runs = useQuery({
  queryKey: ['factory-runs'],
  queryFn: () => api<RunListPage>('/api/agent-runs'),
  refetchInterval: query => query.state.data?.runs.some(run => run.status === 'queued' || run.status === 'running') ? 5000 : false,
})
const recent = computed(() => (runs.data.value?.runs ?? []).slice(0, 5))
</script>
<template>
  <div class="flex h-full min-h-0 min-w-0 flex-col">
    <LayoutPageHeader title="Factory" icon="i-ph-factory">
      <template #actions><UButton v-if="can(Permission.manageProjects)" label="Create project" icon="i-ph-plus" @click="nav.createProjectOpen.value = true" /></template>
    </LayoutPageHeader>
    <main class="mx-auto w-full max-w-5xl flex-1 space-y-8 overflow-auto p-4 sm:p-8">
      <p class="text-sm text-muted">Projects turn into work here: people and agents take their tasks, run them on connected repositories and computers, and report back.</p>

      <section class="space-y-3">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h2 class="font-medium">Projects</h2>
          <div class="flex flex-wrap items-center gap-2">
            <UInput v-if="(projects.data.value?.projects.length ?? 0) > 6" v-model="search" placeholder="Search projects" aria-label="Search projects" icon="i-ph-magnifying-glass" />
            <USwitch v-if="archivedCount" v-model="showArchived" :label="`Archived (${archivedCount})`" />
          </div>
        </div>
        <LayoutSkeleton v-if="projects.isPending.value" variant="rows" :rows="3" />
        <LayoutLoadError v-else-if="projects.error.value" message="Projects did not load." :retry="projects.refetch" />
        <LayoutEmptyState v-else-if="!visible.length" icon="i-ph-folder-simple" :title="search ? 'No matching projects' : 'No projects yet'" :description="can(Permission.manageProjects) ? 'Create a project to gather its tasks, repositories and access.' : 'Projects you can access appear here.'" />
        <ul v-else class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <li v-for="p in visible" :key="p.id">
            <NuxtLink :to="`/factory/projects/${p.id}`" class="flex h-full flex-col gap-1 rounded-lg border border-default p-4 hover:bg-elevated/60">
              <span class="flex items-center gap-2"><UIcon name="i-ph-folder-simple" class="size-4 shrink-0 text-dimmed" /><span class="min-w-0 flex-1 truncate font-medium text-highlighted">{{ p.name }}</span><UBadge v-if="p.archivedAt" label="Archived" color="neutral" variant="subtle" size="sm" /></span>
              <span v-if="p.description" class="line-clamp-2 text-sm text-muted">{{ p.description }}</span>
            </NuxtLink>
          </li>
        </ul>
      </section>

      <section class="space-y-3">
        <div class="flex items-center justify-between gap-3"><h2 class="font-medium">Your recent runs</h2><UButton to="/runs" label="All runs" color="neutral" variant="ghost" size="sm" trailing-icon="i-ph-caret-right" /></div>
        <LayoutSkeleton v-if="runs.isPending.value" variant="rows" :rows="2" />
        <LayoutLoadError v-else-if="runs.error.value" message="Runs did not load." :retry="runs.refetch" />
        <p v-else-if="!recent.length" class="text-sm text-muted">Runs appear here when you message an agent or start an assigned task.</p>
        <ul v-else class="divide-y divide-default rounded-lg border border-default">
          <li v-for="run in recent" :key="run.id">
            <NuxtLink :to="`/runs/${run.id}`" class="block px-4 py-3 hover:bg-elevated/60">
              <div class="flex items-center gap-2">
                <span class="min-w-0 flex-1 truncate text-sm font-medium text-highlighted">{{ run.agentName }}<span v-if="run.taskNumber" class="font-normal text-muted"> · Task #{{ run.taskNumber }}</span></span>
                <UBadge :label="run.status" :color="runStatusColor(run.status)" variant="subtle" size="sm" />
              </div>
              <p class="mt-1 line-clamp-1 text-sm text-muted">{{ displayAgentPrompt(run.prompt) }}</p>
            </NuxtLink>
          </li>
        </ul>
      </section>
    </main>
  </div>
</template>
