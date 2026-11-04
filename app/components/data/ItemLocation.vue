<script setup lang="ts">
import { errorMessage } from '#imports'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { DataItemDetail, DataItemSummary } from '~~/shared/data-items'
import { itemPath } from '~~/shared/data-items'
import type { DataResourcesDTO } from '~~/shared/types'
import { Permission } from '~~/shared/permissions'
const props = defineProps<{ item: DataItemDetail; saveDraft: () => Promise<boolean>; disabled?: boolean }>()
const emit = defineEmits<{ updated: [item: DataItemDetail] }>()
const { api } = useApi()
const { serverId } = useServer()
const { can } = useRoleGrants()
const qc = useQueryClient()
const open = ref(false),
  busy = ref(false),
  error = ref('')
const parentId = ref(''),
  databaseId = ref(''),
  discardProperties = ref(false)
const itemsQ = useQuery({
  queryKey: computed(() => ['items', serverId.value]),
  queryFn: () => api<{ items: DataItemSummary[] }>(`/api/servers/${serverId.value}/items`),
})
const resourcesQ = useQuery({
  queryKey: computed(() => ['data-resources', serverId.value]),
  queryFn: () => api<DataResourcesDTO>(`/api/servers/${serverId.value}/data-resources`),
})
const parent = computed(() => itemsQ.data.value?.items.find((item) => item.id === props.item.parentId))
const database = computed(() => resourcesQ.data.value?.databases.find((db) => db.id === props.item.databaseId))
const parents = computed(() => {
  const items = itemsQ.data.value?.items ?? []
  const excluded = new Set([props.item.id])
  for (let changed = true; changed;) {
    changed = false
    for (const item of items)
      if (item.parentId && excluded.has(item.parentId) && !excluded.has(item.id)) {
        excluded.add(item.id)
        changed = true
      }
  }
  return [
    { value: '', label: 'Top level' },
    ...items.filter((item) => !excluded.has(item.id)).map((item) => ({ value: item.id, label: item.title })),
  ]
})
const databases = computed(() => [
  { value: '', label: 'No database' },
  ...(resourcesQ.data.value?.databases ?? [])
    .filter((db) => !db.archivedAt)
    .map((db) => ({ value: db.id, label: db.name })),
])
const removingProperties = computed(
  () => !!props.item.databaseId && (databaseId.value || null) !== props.item.databaseId,
)
watch(open, (value) => {
  if (value) {
    parentId.value = props.item.parentId ?? ''
    databaseId.value = props.item.databaseId ?? ''
    discardProperties.value = false
    error.value = ''
  }
})
async function move() {
  busy.value = true
  error.value = ''
  try {
    if (!(await props.saveDraft())) return
    await nextTick()
    const result = await api<{ item: DataItemDetail }>(`/api/items/${props.item.id}/move`, {
      method: 'POST',
      body: {
        version: props.item.version,
        parentId: parentId.value || null,
        databaseId: databaseId.value || null,
        discardProperties: discardProperties.value,
      },
    })
    emit('updated', result.item)
    open.value = false
    await qc.invalidateQueries({ queryKey: ['items'] })
  } catch (cause) {
    error.value = errorMessage(cause)
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <div class="mb-4 flex flex-wrap items-center gap-2 text-xs text-muted">
    <ULink v-if="parent" :to="itemPath(parent.id)">{{ parent.title }}</ULink
    ><span v-else>Top level</span>
    <template v-if="database"
      ><span>·</span
      ><ULink :to="`/databases?database=${encodeURIComponent(database.id)}`">{{ database.name }}</ULink></template
    >
    <UButton
      v-if="can(Permission.manageDatabases)"
      label="Move"
      icon="i-ph-folder-simple"
      variant="ghost"
      color="neutral"
      size="xs"
      :disabled="disabled"
      @click="open = true"
    />
  </div>
  <UModal
    v-model:open="open"
    title="Move page"
    description="Choose its parent and, optionally, a database for properties."
  >
    <template #body>
      <div class="space-y-4">
        <UAlert
          v-if="error || itemsQ.error.value || resourcesQ.error.value"
          color="error"
          :description="error || errorMessage(itemsQ.error.value || resourcesQ.error.value)"
        />
        <UFormField label="Inside page"
          ><USelectMenu v-model="parentId" :items="parents" value-key="value" class="w-full"
        /></UFormField>
        <UFormField label="Database"
          ><USelectMenu v-model="databaseId" :items="databases" value-key="value" class="w-full"
        /></UFormField>
        <UCheckbox
          v-if="removingProperties"
          v-model="discardProperties"
          label="Remove existing property values and incoming/outgoing relation links"
          description="The title, content, child pages, history and ordinary links stay with this page."
        />
      </div>
    </template>
    <template #footer
      ><UButton label="Cancel" color="neutral" variant="ghost" @click="open = false" /><UButton
        label="Move"
        :loading="busy"
        :disabled="(removingProperties && !discardProperties) || itemsQ.isPending.value || resourcesQ.isPending.value"
        @click="move"
    /></template>
  </UModal>
</template>
