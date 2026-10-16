<script setup lang="ts">
import { useQueryClient } from '@tanstack/vue-query'
import { canvasPath, databasePath, documentPath } from '~~/shared/paths'
import type { CanvasDTO, DatabaseDTO, DocumentDTO } from '~~/shared/types'

const { workspaceId } = useWorkspace()
const { api } = useApi()
const nav = useNavActions()
const route = useRoute()
const qc = useQueryClient()
const toast = useToast()
const databaseName = ref('')
const documentTitle = ref('')
const canvasTitle = ref('')
const saving = ref(false)

watch(nav.createDatabaseOpen, open => { if (open) databaseName.value = '' })
watch(nav.createDocumentOpen, open => { if (open) documentTitle.value = '' })
watch(nav.createCanvasOpen, open => { if (open) canvasTitle.value = '' })

async function createDatabase() {
  const name = databaseName.value.trim()
  if (!name || !workspaceId.value || saving.value) return
  saving.value = true
  try {
    const result = await api<{ database: DatabaseDTO }>(`/api/workspaces/${workspaceId.value}/databases`, { method: 'POST', body: { name } })
    // Close as soon as it exists; open it once the list includes it.
    nav.createDatabaseOpen.value = false
    await Promise.all([qc.invalidateQueries({ queryKey: ['databases'] }), qc.invalidateQueries({ queryKey: ['data-resources'] })])
    await navigateTo(databasePath(result.database.id))
  }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { saving.value = false }
}

async function createDocument() {
  const title = documentTitle.value.trim()
  if (!title || !workspaceId.value || saving.value) return
  saving.value = true
  try {
    const result = await api<{ document: DocumentDTO }>(`/api/workspaces/${workspaceId.value}/documents`, { method: 'POST', body: { title } })
    nav.createDocumentOpen.value = false
    await qc.invalidateQueries({ queryKey: ['data-resources'] })
    await navigateTo(documentPath(result.document.id))
  }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { saving.value = false }
}

async function createCanvas() {
  const title = canvasTitle.value.trim()
  if (!title || !workspaceId.value || saving.value) return
  saving.value = true
  try {
    const result = await api<{ canvas: CanvasDTO }>(`/api/workspaces/${workspaceId.value}/canvases`, { method: 'POST', body: { title } })
    nav.createCanvasOpen.value = false
    await qc.invalidateQueries({ queryKey: ['data-resources'] })
    await navigateTo(canvasPath(result.canvas.id))
  }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { saving.value = false }
}
</script>

<template>
  <UModal v-if="route.path !== '/databases'" v-model:open="nav.createDatabaseOpen.value" title="Create database">
    <template #body><UFormField label="Name"><UInput v-model="databaseName" autofocus class="w-full" @keyup.enter="createDatabase" /></UFormField></template>
    <template #footer>
      <UButton color="neutral" variant="ghost" label="Cancel" @click="nav.createDatabaseOpen.value = false" />
      <UButton label="Create" :loading="saving" :disabled="!databaseName.trim()" @click="createDatabase" />
    </template>
  </UModal>

  <UModal v-model:open="nav.createDocumentOpen.value" title="Create document">
    <template #body><UFormField label="Title"><UInput v-model="documentTitle" autofocus class="w-full" @keyup.enter="createDocument" /></UFormField></template>
    <template #footer>
      <UButton color="neutral" variant="ghost" label="Cancel" @click="nav.createDocumentOpen.value = false" />
      <UButton label="Create" :loading="saving" :disabled="!documentTitle.trim()" @click="createDocument" />
    </template>
  </UModal>

  <UModal v-model:open="nav.createCanvasOpen.value" title="Create canvas">
    <template #body><UFormField label="Title"><UInput v-model="canvasTitle" autofocus class="w-full" @keyup.enter="createCanvas" /></UFormField></template>
    <template #footer>
      <UButton color="neutral" variant="ghost" label="Cancel" @click="nav.createCanvasOpen.value = false" />
      <UButton label="Create" :loading="saving" :disabled="!canvasTitle.trim()" @click="createCanvas" />
    </template>
  </UModal>
</template>
