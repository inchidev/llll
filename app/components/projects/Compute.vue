<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { L4ComputeSize, ProjectCompute } from '~~/shared/l4-compute'
const props = defineProps<{ projectId: string; archived: boolean }>()
const { api } = useApi(), toast = useToast()
const query = useQuery({ queryKey: computed(() => ['project-compute', props.projectId]),
  queryFn: () => api<{ compute: ProjectCompute; sizes: Record<L4ComputeSize, string>; canManage: boolean }>(`/api/projects/${props.projectId}/compute`) })
const form = ref<ProjectCompute>({ size: 'small' }), busy = ref(false)
watch(() => query.data.value?.compute, compute => { if (compute) form.value = { ...compute } }, { immediate: true })
const editable = computed(() => Boolean(query.data.value?.canManage) && !props.archived)
const changed = computed(() => JSON.stringify(form.value) !== JSON.stringify(query.data.value?.compute))
const items = computed(() => Object.entries(query.data.value?.sizes ?? {}).map(([value, label]) => ({ value, label })))
async function save() {
  busy.value = true
  try { await api(`/api/projects/${props.projectId}/compute`, { method: 'PUT', body: form.value }); await query.refetch(); toast.add({ title: 'Box size saved', color: 'success' }) }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) } finally { busy.value = false }
}
</script>
<template>
  <section class="space-y-4" aria-labelledby="project-compute">
    <div><h3 id="project-compute" class="font-medium">L4 Compute box size</h3><p class="mt-1 text-sm text-muted">The size of each Task’s box when this Project’s repositories run on L4 Compute. It applies to the next box; a box already running keeps its size. Prices are on <a href="https://llll.gg/pricing" target="_blank" rel="noopener" class="underline">llll.gg/pricing</a>.</p></div>
    <LayoutLoadError v-if="query.error.value" message="The box size did not load." :retry="query.refetch" />
    <form v-else-if="query.data.value" class="flex flex-wrap items-end gap-3" @submit.prevent="save">
      <UFormField label="Box size"><USelect v-model="form.size" :items="items" :disabled="!editable" class="w-full sm:w-48" aria-label="L4 Compute box size" /></UFormField>
      <UButton v-if="editable" type="submit" label="Save box size" :disabled="!changed" :loading="busy" />
    </form>
  </section>
</template>
