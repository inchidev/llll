<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { DocumentRevision } from '~~/shared/documents'
import type { DocumentDTO } from '~~/shared/types'

const props = defineProps<{ documentId: string; version: number; writable: boolean; saveDraft: () => Promise<boolean> }>()
const emit = defineEmits<{ restored: [item: DocumentDTO] }>()
const { api } = useApi()
const open = ref(false)
const selected = ref<number | null>(null)
const busy = ref(false)
const error = ref('')
const revisions = useQuery({ queryKey: computed(() => ['document-revisions', props.documentId, props.version]), queryFn: () => api<{ revisions: Omit<DocumentRevision, 'content'>[] }>(`/api/items/${props.documentId}/revisions`), enabled: open })
const preview = useQuery({ queryKey: computed(() => ['document-revision', props.documentId, selected.value]), queryFn: () => api<{ revision: DocumentRevision }>(`/api/items/${props.documentId}/revisions/${selected.value}`), enabled: computed(() => open.value && selected.value !== null) })
watch(() => props.documentId, () => { selected.value = null; open.value = false })
async function restore() {
  if (!selected.value || busy.value) return
  busy.value = true; error.value = ''
  try {
    if (!await props.saveDraft()) { error.value = 'Save or resolve your current draft before restoring a revision.'; return }
    await nextTick()
    const result = await api<{ item: DocumentDTO }>(`/api/items/${props.documentId}/restore`, { method: 'POST', body: { revision: selected.value, version: props.version } })
    emit('restored', result.item); open.value = false
  }
  catch (cause) { error.value = errorMessage(cause) }
  finally { busy.value = false }
}
</script>

<template>
  <UButton icon="i-ph-clock-counter-clockwise" aria-label="Page history" color="neutral" variant="ghost" @click="open = true" />
  <UModal v-model:open="open" title="Page history" description="The last 50 changed versions are kept. Restoring saves a new version and keeps your current one in history.">
    <template #body>
      <LayoutLoadError v-if="revisions.error.value" message="History did not load." :retry="revisions.refetch" />
      <UAlert v-if="error" :description="error" color="error" class="mb-3" />
      <p v-if="!revisions.isPending.value && !revisions.data.value?.revisions.length" class="text-muted">No earlier versions yet.</p>
      <ul class="max-h-48 overflow-y-auto"><li v-for="revision in revisions.data.value?.revisions" :key="revision.version"><UButton :label="`Version ${revision.version} · ${new Date(revision.savedAt).toLocaleString()}`" :variant="selected === revision.version ? 'soft' : 'ghost'" color="neutral" @click="selected = revision.version" /></li></ul>
      <LayoutLoadError v-if="preview.error.value" message="Revision did not load." :retry="preview.refetch" />
      <template v-if="preview.data.value"><p class="my-3 font-medium">{{ preview.data.value.revision.title }}</p><!-- The revision endpoint applies the document HTML allowlist. -->
        <!-- eslint-disable-next-line vue/no-v-html -->
        <div class="prose max-h-80 overflow-y-auto dark:prose-invert" v-html="preview.data.value.revision.content" /></template>
    </template>
    <template #footer><UButton v-if="writable" label="Restore selected version" :disabled="!selected || !preview.data.value" :loading="busy" @click="restore" /></template>
  </UModal>
</template>
