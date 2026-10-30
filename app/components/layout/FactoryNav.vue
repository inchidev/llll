<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { Permission } from '~~/shared/permissions'
import type { Project } from '~~/shared/projects'

const props = defineProps<{ serverId: string }>()
const route = useRoute()
const { api } = useApi()
const nav = useNavActions()
const { can } = useRoleGrants()

const projectsQ = useQuery({
  queryKey: computed(() => ['projects', props.serverId]),
  queryFn: () => api<{ projects: Project[] }>(`/api/servers/${props.serverId}/projects`),
  enabled: computed(() => Boolean(props.serverId)),
})
const projects = computed(() => (projectsQ.data.value?.projects ?? []).filter(project => !project.archivedAt))
const activeProjectId = computed(() => route.path.startsWith('/factory/projects/') ? String(route.params.id || '') : '')
</script>

<template>
  <div>
    <div class="px-2 pb-3">
      <LayoutNavRow to="/factory" :active="route.path === '/factory'">
        <template #leading>
          <UIcon name="i-ph-factory" class="size-[18px] shrink-0 text-dimmed" />
        </template>
        Overview
      </LayoutNavRow>
      <LayoutNavRow to="/runs" :active="route.path.startsWith('/runs')">
        <template #leading>
          <UIcon name="i-ph-list-bullets" class="size-[18px] shrink-0 text-dimmed" />
        </template>
        Runs
      </LayoutNavRow>
    </div>

    <LayoutNavSection
      label="Projects"
      collapse-key="factory:projects"
      :create-label="can(Permission.manageProjects) ? 'Create project' : undefined"
      @create="nav.createProjectOpen.value = true"
    >
      <LayoutSkeleton v-if="projectsQ.isPending.value" variant="nav" :rows="3" />
      <LayoutLoadError v-else-if="projectsQ.error.value" inline message="Projects did not load." :retry="projectsQ.refetch" />
      <p v-else-if="!projects.length" class="px-2 py-3 text-sm text-muted">No projects yet.</p>
      <ul v-else>
        <li v-for="project in projects" :key="project.id">
          <LayoutNavRow :to="`/factory/projects/${project.id}`" :title="project.name" :active="project.id === activeProjectId">
            <template #leading>
              <UIcon name="i-ph-folder-simple" class="size-[18px] shrink-0 text-dimmed" />
            </template>
            {{ project.name }}
          </LayoutNavRow>
        </li>
      </ul>
    </LayoutNavSection>

    <LayoutNavSection v-if="can(Permission.manageServer)" label="Setup" collapse-key="factory:setup" class="mt-3">
      <ul>
        <li>
          <LayoutNavRow @click="nav.openServerSettings('environments')">
            <template #leading>
              <UIcon name="i-ph-git-branch" class="size-[18px] shrink-0 text-dimmed" />
            </template>
            Git
          </LayoutNavRow>
        </li>
        <li>
          <LayoutNavRow @click="nav.openServerSettings('compute')">
            <template #leading>
              <UIcon name="i-ph-cpu" class="size-[18px] shrink-0 text-dimmed" />
            </template>
            Compute
          </LayoutNavRow>
        </li>
      </ul>
    </LayoutNavSection>
  </div>
</template>
