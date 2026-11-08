<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { GitMergeMethod, GitMergeMode, ProjectGitFlow } from '~~/shared/project-factory'
const props = defineProps<{ projectId: string; archived: boolean }>()
const { api } = useApi(), toast = useToast()
const query = useQuery({ queryKey: computed(() => ['project-git-flow', props.projectId]),
  queryFn: () => api<{ gitFlow: ProjectGitFlow; merges: Record<GitMergeMode, { label: string; description: string }>; methods: Record<GitMergeMethod, string>; canManage: boolean }>(`/api/projects/${props.projectId}/git-flow`) })
const form = ref<ProjectGitFlow>({ branchPrefix: 'l4-agent/', merge: 'person', method: 'squash' }), busy = ref(false)
watch(() => query.data.value?.gitFlow, flow => { if (flow) form.value = { ...flow } }, { immediate: true })
const editable = computed(() => Boolean(query.data.value?.canManage) && !props.archived)
const changed = computed(() => JSON.stringify(form.value) !== JSON.stringify(query.data.value?.gitFlow))
const mergeItems = computed(() => Object.entries(query.data.value?.merges ?? {}).map(([value, entry]) => ({ value, label: entry.label, description: entry.description })))
const methodItems = computed(() => Object.entries(query.data.value?.methods ?? {}).map(([value, label]) => ({ value, label })))
async function save() {
  busy.value = true
  try { await api(`/api/projects/${props.projectId}/git-flow`, { method: 'PUT', body: form.value }); await query.refetch(); toast.add({ title: 'Git flow saved', color: 'success' }) }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) } finally { busy.value = false }
}
</script>
<template>
  <section class="space-y-4" aria-labelledby="project-git-flow">
    <div><h3 id="project-git-flow" class="font-medium">Git flow</h3><p class="mt-1 text-sm text-muted">How an Agent’s work reaches each repository’s base branch. Branch protection on GitHub or Gitea still decides: a push or merge it refuses stays refused. In a repository that lives in L4 there are no checks, so only a person merges, and L4 itself keeps the branch rule.</p></div>
    <LayoutLoadError v-if="query.error.value" message="The Git flow did not load." :retry="query.refetch" />
    <form v-else-if="query.data.value" class="space-y-4" @submit.prevent="save">
      <UFormField label="Who merges">
        <URadioGroup v-model="form.merge" variant="card" :items="mergeItems" :disabled="!editable" />
      </UFormField>
      <UFormField v-if="form.merge !== 'direct_push'" label="Agent branch prefix" help="Each Agent’s branch is this prefix and its box’s id, such as l4-agent/1f2e….">
        <UInput v-model="form.branchPrefix" :disabled="!editable" class="w-full font-mono sm:max-w-xs" aria-label="Agent branch prefix" />
      </UFormField>
      <UFormField v-if="form.merge !== 'direct_push'" label="Merge method" help="The repository must allow it.">
        <USelect v-model="form.method" :items="methodItems" :disabled="!editable" class="w-full sm:max-w-xs" />
      </UFormField>
      <UAlert v-if="form.merge === 'direct_push'" color="warning" variant="subtle" description="Approved commits go straight to the base branch, without a pull request or review on GitHub or Gitea. Use it for experiments." />
      <UButton v-if="editable" type="submit" label="Save Git flow" :disabled="!changed" :loading="busy" />
    </form>
  </section>
</template>
