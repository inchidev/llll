<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { ProjectRelease } from '~~/shared/software-factory'
/** The versions of a Project's repository in L4: tags on its base branch, made here by someone who may merge (ADR 0013). */
const props = defineProps<{ projectId: string; archived: boolean }>()
const { api } = useApi(), toast = useToast()
const query = useQuery({ queryKey: computed(() => ['project-releases', props.projectId]),
  queryFn: () => api<{ releases: ProjectRelease[]; repository: { name: string; baseBranch: string } | null; canRelease: boolean }>(`/api/projects/${props.projectId}/releases`) })
const version = ref(''), message = ref(''), busy = ref(false), open = ref(false)
const latest = computed(() => query.data.value?.releases[0] ?? null)
async function release() {
  busy.value = true
  try {
    const result = await api<{ release: ProjectRelease }>(`/api/projects/${props.projectId}/releases`, { method: 'POST', body: { version: version.value.trim(), message: message.value.trim() } })
    toast.add({ title: `${result.release.tag} released`, description: `Tagged ${result.release.sha.slice(0, 12)} on ${query.data.value?.repository?.baseBranch ?? 'main'}.`, color: 'success' })
    version.value = ''; message.value = ''; open.value = false
    await query.refetch()
  } catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) } finally { busy.value = false }
}
</script>
<template>
  <section v-if="query.data.value?.repository" class="space-y-3" aria-labelledby="project-releases">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div><h3 id="project-releases" class="font-medium">Versions</h3><p class="mt-1 text-sm text-muted">A version is a tag on {{ query.data.value.repository.baseBranch }} of {{ query.data.value.repository.name }}. L4 only records it; whatever builds from the repository decides what a version means.</p></div>
      <UButton v-if="query.data.value.canRelease && !archived" label="Release a version" icon="i-ph-tag" color="neutral" variant="outline" @click="open = true" />
    </div>
    <LayoutLoadError v-if="query.error.value" message="The versions did not load." :retry="query.refetch" />
    <p v-else-if="!query.data.value.releases.length" class="text-sm text-muted">No versions yet.</p>
    <ul v-else class="divide-y divide-default rounded-lg border border-default">
      <li v-for="item in query.data.value.releases" :key="item.id" class="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
        <span class="font-mono font-medium text-highlighted">{{ item.tag }}</span>
        <span class="font-mono text-xs text-muted">{{ item.sha.slice(0, 12) }}</span>
        <span class="min-w-0 flex-1 truncate text-muted">{{ item.message }}</span>
        <time class="text-xs text-muted" :datetime="item.createdAt">{{ new Date(item.createdAt).toLocaleDateString() }}</time>
      </li>
    </ul>
    <UModal v-model:open="open" title="Release a version" :description="`Tags the current commit of ${query.data.value.repository.baseBranch} as v<version>. A tag is never moved.`">
      <template #body>
        <form class="space-y-4" @submit.prevent="release">
          <UFormField label="Version" :help="latest ? `The last one was ${latest.tag}.` : 'Such as 1.0.0 or 0.2.0-beta.1.'"><UInput v-model="version" placeholder="1.0.0" class="w-full font-mono sm:max-w-xs" autofocus /></UFormField>
          <UFormField label="Notes" help="Optional. Kept in the tag and shown here."><UTextarea v-model="message" :rows="3" class="w-full" /></UFormField>
          <div class="flex justify-end gap-2"><UButton label="Cancel" color="neutral" variant="outline" :disabled="busy" @click="open = false" /><UButton type="submit" label="Release" :loading="busy" :disabled="!version.trim()" /></div>
        </form>
      </template>
    </UModal>
  </section>
</template>
