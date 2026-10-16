<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { documentPath } from '~~/shared/paths'
import type { DataResourcesDTO, DocumentDTO } from '~~/shared/types'

definePageMeta({ layout: 'workspace', middleware: ['auth', 'manage-databases'] })

const { workspaceId } = useWorkspace()
const isMobile = useIsMobile()
const { api } = useApi()
const route = useRoute()
const nav = useNavActions()
const qc = useQueryClient()
const toast = useToast()
const resourcesQ = useQuery({
  queryKey: computed(() => ['data-resources', workspaceId.value]),
  queryFn: () => api<DataResourcesDTO>(`/api/workspaces/${workspaceId.value}/data-resources`),
  enabled: computed(() => Boolean(workspaceId.value)),
  refetchInterval: 10_000,
})
const documents = computed(() => resourcesQ.data.value?.documents ?? [])
const selectedId = computed(() => String(route.query.document || '') || documents.value[0]?.id || '')
const documentQ = useQuery({
  queryKey: computed(() => ['document', selectedId.value]),
  queryFn: () => api<{ document: DocumentDTO }>(`/api/documents/${selectedId.value}`),
  enabled: computed(() => Boolean(selectedId.value && documents.value.some(document => document.id === selectedId.value))),
})
const activeDocument = computed(() => documentQ.data.value?.document.id === selectedId.value ? documentQ.data.value.document : null)
const { title, content, dirty, saving, saveError, save, discard, cancelScheduledSave, scheduleSave } = useDocumentDraft(
  activeDocument,
  async (id, patch) => {
    const result = await api<{ document: DocumentDTO }>(`/api/documents/${id}`, { method: 'PATCH', body: patch })
    return result.document
  },
  (document) => {
    qc.setQueryData(['document', document.id], { document })
    void qc.invalidateQueries({ queryKey: ['data-resources'] })
  },
)
const deleting = ref(false)
const showDelete = ref(false)
const showReload = ref(false)

async function reloadDocument() {
  const result = await documentQ.refetch()
  if (result.error) { toast.add({ title: errorMessage(result.error), color: 'error' }); return }
  discard()
  showReload.value = false
}

watch([documents, selectedId], ([list, id]) => {
  if (!list.length || !id || list.some(document => document.id === id)) return
  void navigateTo(documentPath(list[0]?.id), { replace: true })
})

// Query-only document switches reuse this page, so both guards must flush.
onBeforeRouteUpdate(() => save())
onBeforeRouteLeave(() => save())

function beforeUnload(event: BeforeUnloadEvent) {
  if (!dirty.value && !saving.value) return
  event.preventDefault()
  event.returnValue = ''
}
onMounted(() => window.addEventListener('beforeunload', beforeUnload))
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload))

async function removeDocument() {
  const document = activeDocument.value
  if (!document || deleting.value || saving.value) return
  cancelScheduledSave()
  deleting.value = true
  try {
    await api(`/api/documents/${document.id}`, { method: 'DELETE' })
    discard()
    showDelete.value = false
    qc.removeQueries({ queryKey: ['document', document.id] })
    await qc.invalidateQueries({ queryKey: ['data-resources'] })
    const next = documents.value.find(item => item.id !== document.id)
    await navigateTo(documentPath(next?.id), { replace: true })
    toast.add({ title: 'Document deleted', color: 'success' })
  }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { deleting.value = false }
}


function retryLoad() {
  return Promise.all([resourcesQ.refetch(), documentQ.refetch()])
}
</script>

<template>
  <div class="flex h-full min-h-0 min-w-0 flex-col">
    <LayoutPageHeader icon="i-ph-file-text" :title="activeDocument ? (title || 'Untitled') : 'Docs'">
      <template #actions>
        <span v-if="activeDocument" class="text-xs text-dimmed">{{ saving ? 'Saving…' : saveError ? 'Not saved' : dirty ? 'Unsaved' : 'Saved' }}</span>
        <DataBookmarkButton v-if="activeDocument" :workspace-id="workspaceId" target-type="document" :target-id="activeDocument.id" />
        <UButton color="neutral" variant="ghost" icon="i-ph-trash" aria-label="Delete document" :disabled="!activeDocument || saving || deleting" @click="showDelete = true" />
        <UButton icon="i-ph-plus" :label="isMobile ? undefined : 'Document'" aria-label="New document" @click="nav.createDocumentOpen.value = true" />
      </template>
    </LayoutPageHeader>

    <div v-if="resourcesQ.isPending.value || (selectedId && documents.some(document => document.id === selectedId) && documentQ.isPending.value)"><LayoutSkeleton variant="document" /></div>
    <LayoutLoadError v-else-if="resourcesQ.error.value || documentQ.error.value" message="Documents did not load." :retry="retryLoad" />
    <div v-else-if="!activeDocument" class="grid flex-1 place-items-center p-6">
      <UButton icon="i-ph-plus" label="Create first document" @click="nav.createDocumentOpen.value = true" />
    </div>
    <main v-else class="min-h-0 flex-1 overflow-y-auto">
      <UAlert v-if="saveError" color="error" title="Document not saved" :description="errorMessage(saveError)" class="m-4 w-auto">
        <template #actions>
          <UButton label="Retry save" color="error" variant="soft" :loading="saving" @click="save()" />
          <UButton label="Reload latest" color="neutral" variant="outline" :disabled="saving" @click="showReload = true" />
        </template>
      </UAlert>
      <div class="mx-auto w-full max-w-4xl px-5 py-8 sm:px-10">
        <UInput
          v-model="title"
          variant="none"
          size="xl"
          aria-label="Document title"
          class="mb-5 w-full"
          :ui="{ base: 'px-0 text-3xl font-semibold' }"
          @update:model-value="scheduleSave"
        />
        <UEditor v-model="content" content-type="html" placeholder="Start writing…" class="min-h-[60vh]" @update:model-value="scheduleSave">
          <template #default="{ editor }">
            <UEditorToolbar :editor="editor" class="sticky top-0 z-10 mb-4 border-b border-default bg-default/95 py-2 backdrop-blur" />
          </template>
        </UEditor>
      </div>
    </main>

    <UModal v-model:open="showReload" title="Discard unsaved changes?">
      <template #body><p class="text-sm text-muted">This replaces your draft with the latest saved document. Copy any text you want to keep first.</p></template>
      <template #footer>
        <UButton color="neutral" variant="ghost" label="Cancel" @click="showReload = false" />
        <UButton color="error" label="Discard and reload" :loading="documentQ.isFetching.value" @click="reloadDocument" />
      </template>
    </UModal>
    <UModal v-model:open="showDelete" title="Delete document?">
      <template #body><p class="text-sm text-muted">This cannot be undone.</p></template>
      <template #footer>
        <UButton color="neutral" variant="ghost" label="Cancel" @click="showDelete = false" />
        <UButton color="error" label="Delete" :loading="deleting" @click="removeDocument" />
      </template>
    </UModal>
  </div>
</template>
