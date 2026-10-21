<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { canvasPath, databasePath, documentPath } from '~~/shared/paths'
import { Permission } from '~~/shared/permissions'
import type { DataResourcesDTO } from '~~/shared/types'

const props = defineProps<{ serverId: string; view: 'databases' | 'documents' | 'canvases' }>()
const route = useRoute()
const { api } = useApi()
const nav = useNavActions()
const { can } = useRoleGrants()

const archived = computed(() => route.path === '/databases' && route.query.archived === '1')
const resourcesQ = useQuery({
  queryKey: computed(() => ['data-resources', props.serverId]),
  queryFn: () => api<DataResourcesDTO>(`/api/servers/${props.serverId}/data-resources`),
  enabled: computed(() => Boolean(props.serverId)),
  refetchInterval: 10_000,
})
const databases = computed(() => {
  const list = resourcesQ.data.value?.databases ?? []
  return list.filter(database => Boolean(database.archivedAt) === archived.value)
})
const documents = computed(() => resourcesQ.data.value?.documents ?? [])
const canvases = computed(() => resourcesQ.data.value?.canvases ?? [])
const activeDatabaseId = computed(() => route.path === '/databases' ? String(route.query.database || '') || databases.value[0]?.id || '' : '')
const activeDocumentId = computed(() => route.path === '/documents' ? String(route.query.document || '') || documents.value[0]?.id || '' : '')
const activeCanvasId = computed(() => route.path === '/canvases' ? String(route.query.canvas || '') || canvases.value[0]?.id || '' : '')
const bookmarks = computed(() => (resourcesQ.data.value?.bookmarks ?? []).flatMap((bookmark) => {
  if (props.view === 'databases' && bookmark.targetType === 'database_view') {
    for (const database of resourcesQ.data.value?.databases ?? []) {
      if (database.archivedAt) continue
      const view = database.views.find(candidate => candidate.id === bookmark.targetId)
      if (view) return [{ ...bookmark, label: `${database.name} / ${view.name}`, icon: 'i-ph-layout', to: databasePath(database.id, false, view.id) }]
    }
  }
  if (props.view === 'documents' && bookmark.targetType === 'document') {
    const document = documents.value.find(candidate => candidate.id === bookmark.targetId)
    if (document) return [{ ...bookmark, label: document.title, icon: 'i-ph-file-text', to: documentPath(document.id) }]
  }
  if (props.view === 'canvases' && bookmark.targetType === 'canvas') {
    const canvas = canvases.value.find(candidate => candidate.id === bookmark.targetId)
    if (canvas) return [{ ...bookmark, label: canvas.title, icon: 'i-ph-selection-background', to: canvasPath(canvas.id) }]
  }
  return []
}))
</script>

<template>
  <div class="space-y-1">
    <LayoutNavSection v-if="bookmarks.length" label="Bookmarks" collapse-key="data:bookmarks">
      <ul>
        <li v-for="bookmark in bookmarks" :key="`${bookmark.targetType}:${bookmark.targetId}`">
          <LayoutNavRow :to="bookmark.to" :title="bookmark.label" :active="route.fullPath === bookmark.to">
            <template #leading><UIcon :name="bookmark.icon" class="size-[18px] shrink-0 text-dimmed" /></template>
            {{ bookmark.label }}
          </LayoutNavRow>
        </li>
      </ul>
    </LayoutNavSection>

    <LayoutNavSection
      v-if="view === 'databases'"
      label="Databases"
      collapse-key="data:databases"
      :create-label="!archived && can(Permission.manageDatabases) ? 'Create database' : undefined"
      @create="nav.createDatabaseOpen.value = true"
    >
      <LayoutSkeleton v-if="resourcesQ.isPending.value" variant="nav" :rows="2" />
      <LayoutLoadError v-else-if="resourcesQ.error.value" inline message="Data did not load." :retry="resourcesQ.refetch" />
      <p v-else-if="!databases.length" class="px-2 py-2 text-sm text-muted">{{ archived ? 'Nothing archived.' : 'No databases yet.' }}</p>
      <ul v-else>
        <li v-for="database in databases" :key="database.id">
          <LayoutNavRow :to="databasePath(database.id, archived, database.views[0]?.id)" :title="database.name" :active="database.id === activeDatabaseId">
            <template #leading><UIcon name="i-ph-table" class="size-[18px] shrink-0 text-dimmed" /></template>
            {{ database.name }}
            <template #trailing><span v-if="database.itemCount" class="shrink-0 text-[11px] text-dimmed">{{ database.itemCount }}</span></template>
          </LayoutNavRow>
        </li>
      </ul>
    </LayoutNavSection>

    <LayoutNavSection v-if="view === 'documents'" label="Documents" collapse-key="data:documents" :create-label="can(Permission.writeData) ? 'Create document' : undefined" @create="nav.createDocumentOpen.value = true">
      <LayoutSkeleton v-if="resourcesQ.isPending.value" variant="nav" :rows="2" />
      <LayoutLoadError v-else-if="resourcesQ.error.value" inline message="Documents did not load." :retry="resourcesQ.refetch" />
      <p v-else-if="!documents.length" class="px-2 py-2 text-sm text-muted">No documents yet.</p>
      <ul v-else>
        <li v-for="document in documents" :key="document.id">
          <LayoutNavRow :to="documentPath(document.id)" :title="document.title" :active="document.id === activeDocumentId">
            <template #leading><UIcon name="i-ph-file-text" class="size-[18px] shrink-0 text-dimmed" /></template>
            {{ document.title }}
          </LayoutNavRow>
        </li>
      </ul>
    </LayoutNavSection>

    <LayoutNavSection v-if="view === 'canvases'" label="Canvases" collapse-key="data:canvases" :create-label="can(Permission.manageDatabases) ? 'Create canvas' : undefined" @create="nav.createCanvasOpen.value = true">
      <LayoutSkeleton v-if="resourcesQ.isPending.value" variant="nav" :rows="2" />
      <LayoutLoadError v-else-if="resourcesQ.error.value" inline message="Canvases did not load." :retry="resourcesQ.refetch" />
      <p v-else-if="!canvases.length" class="px-2 py-2 text-sm text-muted">No canvases yet.</p>
      <ul v-else>
        <li v-for="canvas in canvases" :key="canvas.id">
          <LayoutNavRow :to="canvasPath(canvas.id)" :title="canvas.title" :active="canvas.id === activeCanvasId">
            <template #leading><UIcon name="i-ph-selection-background" class="size-[18px] shrink-0 text-dimmed" /></template>
            {{ canvas.title }}
            <template #trailing><span v-if="canvas.nodeCount" class="shrink-0 text-[11px] text-dimmed">{{ canvas.nodeCount }}</span></template>
          </LayoutNavRow>
        </li>
      </ul>
    </LayoutNavSection>

    <div v-if="view === 'databases' && !resourcesQ.isPending.value" class="px-2 pt-2">
      <LayoutNavRow :to="databasePath(null, !archived)" :active="archived">
        <template #leading><UIcon name="i-ph-archive" class="size-[18px] shrink-0 text-dimmed" /></template>
        Archived databases
      </LayoutNavRow>
    </div>
  </div>
</template>
