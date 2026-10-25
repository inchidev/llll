<script setup lang="ts">
import { useQueryClient } from '@tanstack/vue-query'
import { canvasPath, databasePath, documentPath } from '~~/shared/paths'
import type { CanvasDTO, DatabaseDTO, DocumentDTO } from '~~/shared/types'
import { documentCreateGuardKey } from '../../composables/useDocumentCreateGuard'

const { serverId } = useServer()
const { api } = useApi()
const nav = useNavActions()
const route = useRoute()
const qc = useQueryClient()
const toast = useToast()
const databaseName = ref('')
const documentGuard = inject(documentCreateGuardKey, null)
const canvasTitle = ref('')
const saving = ref(false)

watch(nav.createDatabaseOpen, open => { if (open) databaseName.value = '' })
watch(nav.createDocumentOpen, open => {
  if (!open) return
  nav.createDocumentOpen.value = false
  void createDocument()
})
watch(nav.createCanvasOpen, open => { if (open) canvasTitle.value = '' })

async function createDatabase() {
  const name = databaseName.value.trim()
  if (!name || !serverId.value || saving.value) return
  saving.value = true
  try {
    const result = await api<{ database: DatabaseDTO }>(`/api/servers/${serverId.value}/databases`, { method: 'POST', body: { name } })
    // Close as soon as it exists; open it once the list includes it.
    nav.createDatabaseOpen.value = false
    await Promise.all([qc.invalidateQueries({ queryKey: ['databases'] }), qc.invalidateQueries({ queryKey: ['data-resources'] })])
    await navigateTo(databasePath(result.database.id))
  }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { saving.value = false }
}

async function createDocument() {
  if (!serverId.value || nav.documentCreating.value) return
  nav.documentCreating.value = true
  try {
    if (documentGuard?.value && !await documentGuard.value()) return
    const result = await api<{ document: DocumentDTO }>(`/api/servers/${serverId.value}/documents`, { method: 'POST', body: {} })
    qc.setQueryData(['document', result.document.id], result)
    await qc.invalidateQueries({ queryKey: ['data-resources'] })
    await navigateTo(documentPath(result.document.id))
  }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { nav.documentCreating.value = false }
}

async function createCanvas() {
  const title = canvasTitle.value.trim()
  if (!title || !serverId.value || saving.value) return
  saving.value = true
  try {
    const result = await api<{ canvas: CanvasDTO }>(`/api/servers/${serverId.value}/canvases`, { method: 'POST', body: { title } })
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

  <UModal v-model:open="nav.createCanvasOpen.value" title="Create canvas">
    <template #body><UFormField label="Title"><UInput v-model="canvasTitle" autofocus class="w-full" @keyup.enter="createCanvas" /></UFormField></template>
    <template #footer>
      <UButton color="neutral" variant="ghost" label="Cancel" @click="nav.createCanvasOpen.value = false" />
      <UButton label="Create" :loading="saving" :disabled="!canvasTitle.trim()" @click="createCanvas" />
    </template>
  </UModal>
</template>
