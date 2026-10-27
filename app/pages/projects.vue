<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { Permission, hasPermission } from '~~/shared/permissions'
import type { Project, ProjectRepository } from '~~/shared/projects'
definePageMeta({ layout: 'server', middleware: ['auth'] })
const { api } = useApi(), { serverId } = useServer(), { can } = useRoleGrants()
const toast = useToast(), busy = ref(false), name = ref(''), description = ref(''), selected = ref<string | null>(null)
const projectOpen = ref(false), repositoryOpen = ref(false), search = ref('')
const projects = useQuery({ queryKey: computed(() => ['projects', serverId.value]), queryFn: () => api<{ projects: Project[] }>(`/api/servers/${serverId.value}/projects`) })
const detail = useQuery({ queryKey: computed(() => ['project', selected.value]), queryFn: () => api<{ project: Project; repositories: ProjectRepository[]; permissions: number }>(`/api/projects/${selected.value}`), enabled: computed(() => Boolean(selected.value)) })
const visible = computed(() => (projects.data.value?.projects ?? []).filter(p => p.name.toLowerCase().includes(search.value.toLowerCase())))
const environments = useQuery({ queryKey: ['code-environments'], queryFn: () => api<{ environments: { id: string; name: string; sourceRepo: string; sourceRepoId: number; baseBranch: string }[] }>('/api/code-environments'), enabled: computed(() => can(Permission.manageProjects)) })
const environmentId = ref<string | null>(null)
const provider = ref('github'), host = ref('https://github.com'), slug = ref(''), externalId = ref(''), branch = ref('main')
watch(environmentId, id => { const e = environments.data.value?.environments.find(e => e.id === id); if (e) { provider.value = 'github'; host.value = 'https://github.com'; slug.value = e.sourceRepo; externalId.value = String(e.sourceRepoId); branch.value = e.baseBranch } else externalId.value = '' })
async function create() {
 busy.value = true
 try { const r = await api<{ project: Project }>(`/api/servers/${serverId.value}/projects`, { method: 'POST', body: { name: name.value, description: description.value } }); name.value = ''; description.value = ''; selected.value = r.project.id; projectOpen.value = false; await projects.refetch() }
 catch (e) { toast.add({ title: errorMessage(e), color: 'error' }) } finally { busy.value = false }
}
async function attach() {
 busy.value = true
 try { await api(`/api/projects/${selected.value}/repositories`, { method: 'POST', body: { provider: provider.value, host: host.value, slug: slug.value, externalId: externalId.value || undefined, defaultBranch: branch.value, environmentId: environmentId.value || null } }); slug.value = ''; externalId.value = ''; repositoryOpen.value = false; await detail.refetch() }
 catch (e) { toast.add({ title: errorMessage(e), color: 'error' }) } finally { busy.value = false }
}
async function archive() {
 if (!detail.data.value) return
 busy.value = true
 try { await api(`/api/projects/${selected.value}`, { method: 'PATCH', body: { version: detail.data.value.project.version, archived: !detail.data.value.project.archivedAt } }); await detail.refetch(); await projects.refetch() }
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
  <LayoutPageHeader title="Projects" icon="i-ph-folder-simple" />
  <main class="mx-auto w-full max-w-5xl flex-1 space-y-6 overflow-auto p-4 sm:p-8">
   <p class="text-sm text-muted">Organize work and repository references by project. Project access does not grant Git credentials or permission to merge or release.</p>
   <LayoutLoadError v-if="projects.error.value" message="Projects did not load." :retry="projects.refetch" />
   <div class="flex flex-wrap items-center justify-between gap-3"><UInput v-model="search" placeholder="Search projects" aria-label="Search projects" /><UButton v-if="can(Permission.manageProjects)" label="Create project" icon="i-ph-plus" @click="projectOpen = true" /></div>
   <div class="divide-y divide-default rounded-lg border border-default"><button v-for="p in visible" :key="p.id" class="flex w-full items-center justify-between gap-3 p-4 text-left hover:bg-elevated" :aria-pressed="selected === p.id" @click="selected = p.id"><span class="font-medium">{{ p.name }}</span><UBadge v-if="p.archivedAt" label="Archived" color="neutral" /><UIcon v-else name="i-ph-caret-right" class="size-4" /></button></div>
   <UModal v-model:open="projectOpen" title="Create project" description="Organize tasks, repositories and access for people and agents."><template #body><form class="space-y-4" @submit.prevent="create">
    <h2 class="font-medium">Create project</h2><p class="text-sm text-muted">After creation, assign project access to people and agents. You can also attach repositories and their execution configuration.</p>
    <UFormField label="Project name"><UInput v-model="name" class="w-full" :maxlength="100" /></UFormField>
    <UFormField label="Description"><UTextarea v-model="description" class="w-full" /></UFormField>
    <UButton type="submit" label="Create project" :disabled="!name.trim()" :loading="busy" />
   </form></template></UModal>
   <LayoutLoadError v-if="detail.error.value" message="Project did not load." :retry="detail.refetch" />
   <section v-if="selected && detail.data.value" class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3"><h2 class="text-lg font-medium">{{ detail.data.value.project.name }}</h2><UButton v-if="can(Permission.manageProjects)" :label="detail.data.value.project.archivedAt ? 'Restore project' : 'Archive project'" color="neutral" variant="outline" :loading="busy" @click="archive" /></div>
    <p class="whitespace-pre-wrap text-sm text-muted">{{ detail.data.value.project.description }}</p>
    <UButton v-if="hasPermission(detail.data.value.permissions, Permission.readTasks)" :to="`/tasks?project=${selected}`" label="Open project tasks" icon="i-ph-kanban" color="neutral" variant="outline" />
    <ProjectsAccess :key="selected" :project-id="selected" />
    <div class="flex items-center justify-between gap-3"><h3 class="font-medium">Repositories</h3><UButton v-if="can(Permission.manageProjects) && !detail.data.value.project.archivedAt" label="Attach repository" icon="i-ph-plus" color="neutral" variant="outline" @click="repositoryOpen = true" /></div>
    <p class="text-sm text-muted">These references identify external repositories. Attaching a reference does not connect credentials or enable execution. Git operations still require a configured provider connection.</p>
    <div v-for="r in detail.data.value.repositories" :key="r.id" class="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded border border-default p-3">
     <div class="min-w-0"><p class="break-all font-medium">{{ r.slug }}</p><p class="break-all text-xs text-muted">{{ r.provider }} · {{ r.host }} · {{ r.defaultBranch }}</p><p class="text-xs text-muted">{{ r.environmentId ? 'Linked to Git execution configuration' : 'Reference only; execution not connected' }}</p></div>
     <UButton v-if="can(Permission.manageProjects)" label="Detach reference" color="neutral" variant="ghost" :loading="busy" @click="remove(r.id)" />
    </div>
    <UModal v-model:open="repositoryOpen" title="Attach repository" description="Connect a repository reference to this project."><template #body><form class="space-y-4" @submit.prevent="attach">
     <h3 class="font-medium">Attach repository reference</h3>
     <UFormField label="Git provider"><USelect v-model="provider" :items="['github', 'gitlab', 'gitea', 'cursor']" class="w-full" /></UFormField>
     <UFormField label="Provider origin"><UInput v-model="host" placeholder="https://github.com" class="w-full" /></UFormField>
     <UFormField label="Repository path"><UInput v-model="slug" placeholder="organization/repository" class="w-full" /></UFormField>
     <UFormField label="Default branch"><UInput v-model="branch" class="w-full" /></UFormField>
     <UFormField label="Coding environment" help="Configure GitHub access in Server settings → Repositories, then link the matching configuration. Other providers are references until their execution adapter is available."><USelect v-model="environmentId" :items="[{ label: 'Reference only', value: null }, ...(environments.data.value?.environments ?? []).map(e => ({ label: e.name + ' · ' + e.sourceRepo, value: e.id }))]" class="w-full" /></UFormField>
     <UButton type="submit" label="Attach reference" :disabled="!slug || !host" :loading="busy" />
    </form></template></UModal>
   </section>
  </main>
 </div>
</template>
