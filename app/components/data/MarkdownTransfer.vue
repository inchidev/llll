<script setup lang="ts">
import { useQueryClient } from '@tanstack/vue-query'
import type { DocumentDTO } from '~~/shared/types'
import { documentPath } from '~~/shared/paths'
import { DOCUMENT_CONTENT_MAX } from '~~/shared/documents'
import { downloadDataFile } from '~/utils/data-download'

const props = defineProps<{ documentId?: string; saveDraft?: () => Promise<boolean>; writable: boolean }>()
const { api } = useApi()
const { serverId } = useServer()
const qc = useQueryClient()
const open = ref(false)
const busy = ref(false)
const error = ref('')
async function importFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file || busy.value) return
  busy.value = true; error.value = ''
  try {
    if (props.saveDraft && !await props.saveDraft()) throw new Error('Save or resolve the current draft first')
    if (file.size > DOCUMENT_CONTENT_MAX) throw new Error('Choose a Markdown file no larger than 1 MB')
    const result = await api<{ item: DocumentDTO }>(`/api/servers/${serverId.value}/items`, { method: 'POST', body: { title: file.name.replace(/\.(md|markdown)$/iu, '').slice(0, 160) || undefined, content: await file.text(), format: 'markdown' } })
    qc.setQueryData(['item', result.item.id], result)
    await qc.invalidateQueries({ queryKey: ['data-resources'] })
    open.value = false
    await navigateTo(documentPath(result.item.id))
  }
  catch (cause) { error.value = errorMessage(cause) }
  finally { busy.value = false }
}
async function download() {
  if (!props.documentId) return
  busy.value = true; error.value = ''
  try {
    if (props.saveDraft && !await props.saveDraft()) throw new Error('Save or resolve the current draft first')
    const contents = await api<string>(`/api/items/${props.documentId}/export`)
    downloadDataFile(contents, 'page.md', 'text/markdown;charset=utf-8')
  }
  catch (cause) { error.value = errorMessage(cause) }
  finally { busy.value = false }
}
</script>

<template>
  <UButton label="Markdown" icon="i-ph-file-md" color="neutral" variant="ghost" @click="open = true" />
  <UModal v-model:open="open" title="Markdown files" :dismissible="!busy">
    <template #body>
      <UAlert v-if="error" :description="error" color="error" class="mb-3" />
      <UButton v-if="documentId" label="Export this page" icon="i-ph-download-simple" :loading="busy" @click="download" />
      <UFormField v-if="writable" label="Import a new page" description="Formatting is converted to the page editor. A file never replaces an existing page." class="mt-4"><input type="file" accept=".md,.markdown,text/markdown" :disabled="busy" @change="importFile"></UFormField>
    </template>
  </UModal>
</template>
