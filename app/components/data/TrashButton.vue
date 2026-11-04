<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { DataTrashEntry } from '~~/shared/data-trash'

const { api } = useApi()
const qc = useQueryClient()
const open = ref(false)
const busy = ref(false)
const error = ref('')
const purging = ref<DataTrashEntry | null>(null)
const trash = useQuery({ queryKey: ['data-trash'], queryFn: () => api<{ entries: DataTrashEntry[] }>('/api/data-trash'), enabled: open })
async function act(entry: DataTrashEntry, action: 'restore' | 'purge') {
  if (busy.value) return
  busy.value = true; error.value = ''
  try {
    await api('/api/data-trash', { method: 'POST', body: { type: entry.type, id: entry.id, action } })
    purging.value = null
    await Promise.all([trash.refetch(), qc.invalidateQueries({ queryKey: ['data-resources'] }), qc.invalidateQueries({ queryKey: ['database'] })])
  }
  catch (cause) { error.value = errorMessage(cause) }
  finally { busy.value = false }
}
</script>

<template>
  <UButton label="Trash" icon="i-ph-trash" color="neutral" variant="ghost" @click="open = true" />
  <UModal v-model:open="open" title="Trash" description="Restore an item, or delete it permanently. Restore a database before its individual records or fields.">
    <template #body>
      <LayoutLoadError v-if="trash.error.value" message="Trash did not load." :retry="trash.refetch" />
      <UAlert v-if="error" :description="error" color="error" class="mb-3" />
      <LayoutSkeleton v-if="trash.isPending.value" variant="nav" :rows="3" />
      <p v-else-if="!trash.data.value?.entries.length" class="text-muted">Trash is empty.</p>
      <ul v-else class="divide-y divide-default">
        <li v-for="entry in trash.data.value.entries" :key="`${entry.type}:${entry.id}`" class="flex flex-wrap items-center gap-2 py-3">
          <div class="min-w-0 flex-1"><p class="truncate font-medium">{{ entry.title }}</p><p class="text-xs text-muted">{{ entry.type }} · {{ new Date(entry.deletedAt).toLocaleDateString() }}</p></div>
          <UButton label="Restore" color="neutral" variant="soft" :disabled="busy" @click="act(entry, 'restore')" />
          <UButton aria-label="Delete permanently" icon="i-ph-trash" color="error" variant="ghost" :disabled="busy" @click="purging = entry" />
        </li>
      </ul>
      <div v-if="purging" class="mt-4 rounded border border-error p-3">
        <p>Delete <strong>{{ purging.title }}</strong> permanently, including its children? This cannot be undone.</p>
        <div class="mt-3 flex gap-2"><UButton label="Cancel" variant="ghost" color="neutral" @click="purging = null" /><UButton label="Delete permanently" color="error" :loading="busy" @click="act(purging, 'purge')" /></div>
      </div>
    </template>
  </UModal>
</template>
