<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { Permission } from '~~/shared/permissions'
import { databasePath, documentPath, canvasPath } from '~~/shared/paths'
import type { DataResourcesDTO } from '~~/shared/types'
definePageMeta({ layout: 'server', middleware: ['auth', 'manage-databases'] })
const { serverId } = useServer()
const { api } = useApi()
const { can } = useRoleGrants()
const nav = useNavActions()
const resources = useQuery({ queryKey: computed(() => ['data-resources', serverId.value]), queryFn: () => api<DataResourcesDTO>(`/api/servers/${serverId.value}/data-resources`), enabled: computed(() => Boolean(serverId.value)) })
const groups = computed(() => [
  { name: 'Documents', createLabel: 'New document', canCreate: can(Permission.writeData), create: () => { nav.createDocumentOpen.value = true }, icon: 'i-ph-file-text', items: (resources.data.value?.documents ?? []).map(item => ({ id: item.id, title: item.title || 'Untitled', to: documentPath(item.id) })) },
  { name: 'Databases', createLabel: 'New database', canCreate: can(Permission.manageDatabases), create: () => { nav.createDatabaseOpen.value = true }, icon: 'i-ph-table', items: (resources.data.value?.databases ?? []).filter(item => !item.archivedAt).map(item => ({ id: item.id, title: item.name, to: databasePath(item.id) })) },
  { name: 'Canvases', createLabel: 'New canvas', canCreate: can(Permission.manageDatabases), create: () => { nav.createCanvasOpen.value = true }, icon: 'i-ph-selection-background', items: (resources.data.value?.canvases ?? []).map(item => ({ id: item.id, title: item.title, to: canvasPath(item.id) })) },
])
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <LayoutPageHeader title="Data" icon="i-ph-stack"><template #actions><UButton v-if="can(Permission.writeData)" label="New document" icon="i-ph-plus" :loading="nav.documentCreating.value" @click="nav.createDocumentOpen.value = true" /></template></LayoutPageHeader>
    <main class="min-h-0 flex-1 overflow-y-auto p-5 sm:p-8"><div class="mx-auto max-w-3xl">
      <h2 class="text-xl font-semibold text-highlighted">A place for your team's knowledge</h2><p class="mt-1 text-sm text-muted">Keep documents, structured data and canvases together.</p>
      <LayoutSkeleton v-if="resources.isPending.value" variant="nav" :rows="5" class="mt-6" />
      <LayoutLoadError v-else-if="resources.error.value" message="Data did not load." :retry="resources.refetch" />
      <div v-else class="mt-8 space-y-8"><section v-for="group in groups" :key="group.name"><div class="mb-2 flex items-center justify-between gap-3"><h3 class="text-sm font-semibold text-highlighted">{{ group.name }}</h3><UButton v-if="group.canCreate" :label="group.createLabel" icon="i-ph-plus" color="neutral" variant="ghost" size="sm" :loading="group.name === 'Documents' && nav.documentCreating.value" @click="group.create" /></div><p v-if="!group.items.length" class="py-3 text-sm text-muted">No {{ group.name.toLowerCase() }} yet.</p><ul v-else class="divide-y divide-default"><li v-for="item in group.items" :key="item.id"><NuxtLink :to="item.to" :title="item.title" class="flex min-h-12 items-center gap-3 rounded-lg px-3 py-3 text-sm hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary"><UIcon :name="group.icon" class="size-5 text-muted" /><span class="truncate">{{ item.title }}</span></NuxtLink></li></ul></section></div>
    </div></main>
  </div>
</template>
