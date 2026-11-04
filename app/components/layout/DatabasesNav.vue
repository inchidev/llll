<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { databasePath, documentPath } from '~~/shared/paths'
import { Permission } from '~~/shared/permissions'
import type { DataResourcesDTO } from '~~/shared/types'

const props = defineProps<{ serverId: string }>()
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
const items = computed(()=>resourcesQ.data.value?.items ?? [])
const activeDatabaseId = computed(() => route.path === '/databases' ? String(route.query.database || '') || databases.value[0]?.id || '' : '')
const bookmarks = computed(() => (resourcesQ.data.value?.bookmarks ?? []).flatMap((bookmark) => {
  if (bookmark.targetType === 'database_view') {
    for (const database of resourcesQ.data.value?.databases ?? []) {
      if (database.archivedAt) continue
      const view = database.views.find(candidate => candidate.id === bookmark.targetId)
      if (view) return [{ ...bookmark, label: `${database.name} / ${view.name}`, icon: 'i-ph-layout', to: databasePath(database.id, false, view.id) }]
    }
  }
  if (bookmark.targetType === 'item') {
    const item = resourcesQ.data.value?.items.find(item=>item.id===bookmark.targetId)
    if (item) return [{ ...bookmark, label:item.title, icon:item.kind==='canvas'?'i-ph-selection-background':'i-ph-file-text', to:documentPath(item.id) }]
  }
  return []
}))
</script>

<template>
  <div class="space-y-3">
    <div class="px-2"><LayoutNavRow to="/data" :active="route.path === '/data'"><template #leading><UIcon name="i-ph-stack" class="size-[18px] text-muted" /></template>All data</LayoutNavRow></div>
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

    <LayoutNavSection label="Pages" collapse-key="data:pages" :create-label="can(Permission.writeData) ? 'Create page' : undefined" @create="nav.createDocumentOpen.value = true">
      <LayoutSkeleton v-if="resourcesQ.isPending.value" variant="nav" :rows="2" />
      <LayoutLoadError v-else-if="resourcesQ.error.value" inline message="Pages did not load." :retry="resourcesQ.refetch" />
      <DataItemTree v-else :items="items" />
    </LayoutNavSection>

    <LayoutNavSection
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

    <div v-if="!resourcesQ.isPending.value" class="px-2 pt-2">
      <LayoutNavRow :to="databasePath(null, !archived)" :active="archived">
        <template #leading><UIcon name="i-ph-archive" class="size-[18px] shrink-0 text-dimmed" /></template>
        Archived databases
      </LayoutNavRow>
    </div>
  </div>
</template>
