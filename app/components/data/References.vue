<script setup lang="ts">
import { errorMessage } from '#imports'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { refDebounced } from '@vueuse/core'
import type { DataReferenceType, DataSearchHit, DataReferences } from '~~/shared/data-search'
import { itemPath } from '~~/shared/data-items'
import { databasePath, boardPath } from '~~/shared/paths'
const props = defineProps<{ type: DataReferenceType; id: string; writable?: boolean }>()
const { api } = useApi()
const { serverId } = useServer()
const qc = useQueryClient()
const query = ref('')
const term = refDebounced(query, 250)
const adding = ref(false)
const busy = ref(false)
const error = ref('')
const references = useQuery({ queryKey: computed(() => ['data-references', serverId.value, props.type, props.id]), queryFn: () => api<DataReferences>('/api/data-references', { query: { type: props.type, id: props.id } }) })
const search = useQuery({ queryKey: computed(() => ['data-search', serverId.value, term.value]), queryFn: () => api<{ hits: DataSearchHit[] }>('/api/data-search', { query: { q: term.value } }), enabled: computed(() => adding.value && term.value.trim().length >= 2) })
const candidates = computed(() => term.value.trim().length < 2 ? [] : (search.data.value?.hits ?? []).filter(hit => !(hit.type === props.type && hit.id === props.id) && !references.data.value?.outgoing.some(link => link.type === hit.type && link.id === hit.id)))
function path(hit: DataSearchHit) {
  if (hit.type === 'task') return `${boardPath(hit.resourceId)}&task=${encodeURIComponent(hit.id)}`
  if (hit.type === 'database') return databasePath(hit.id)
  return itemPath(hit.id)
}
async function change(hit: DataSearchHit, remove = false) {
  busy.value = true; error.value = ''
  try {
    await api('/api/data-references', { method: 'POST', body: { source: { type: props.type, id: props.id }, target: { type: hit.type, id: hit.id }, remove } })
    await qc.invalidateQueries({ queryKey: ['data-references', serverId.value] })
    query.value = ''; adding.value = false
  }
  catch (cause) { error.value = errorMessage(cause) }
  finally { busy.value = false }
}
</script>
<template>
  <section class="mt-5 space-y-3 rounded-lg border border-default p-3" aria-label="Linked resources">
    <div class="flex items-center justify-between"><h3 class="text-sm font-medium">Links</h3><UButton v-if="writable" label="Add link" icon="i-ph-link" size="xs" variant="ghost" @click="adding = !adding" /></div>
    <UAlert v-if="error || references.error.value || search.error.value" :description="error || errorMessage(references.error.value || search.error.value)" color="error" />
    <template v-for="direction in (['outgoing', 'incoming'] as const)" :key="direction">
      <p v-if="direction === 'incoming' && references.data.value?.incoming.length" class="text-xs text-muted">Linked from</p>
      <div v-for="hit in references.data.value?.[direction] ?? []" :key="`${hit.type}:${hit.id}`" class="flex min-w-0 items-center gap-2 rounded border border-default px-2 py-1.5">
        <UBadge :label="hit.type" size="xs" color="neutral" variant="subtle" />
        <ULink :to="path(hit)" class="min-w-0 flex-1 truncate text-sm text-primary">{{ hit.title }}</ULink>
        <UButton v-if="writable && direction === 'outgoing'" icon="i-ph-x" aria-label="Remove link" variant="ghost" color="neutral" size="xs" :disabled="busy" @click="change(hit, true)" />
      </div>
    </template>
    <p v-if="!references.isPending.value && !references.data.value?.outgoing.length && !references.data.value?.incoming.length" class="text-xs text-muted">No links yet.</p>
    <div v-if="adding" class="space-y-2">
      <UInput v-model="query" placeholder="Search documents, records and Tasks…" aria-label="Find a resource to link" class="w-full" />
      <div class="max-h-52 overflow-y-auto"><UButton v-for="hit in candidates" :key="`${hit.type}:${hit.id}`" :label="`${hit.title} · ${hit.type}`" color="neutral" variant="ghost" class="flex w-full justify-start text-left" :disabled="busy" @click="change(hit)" /></div>
      <p v-if="term.trim().length >= 2 && !search.isFetching.value && !candidates.length" class="text-xs text-muted">No matching resources you can access.</p>
    </div>
  </section>
</template>
