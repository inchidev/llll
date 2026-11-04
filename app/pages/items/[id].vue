<script setup lang="ts">
import { errorMessage } from '#imports'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { Permission } from '~~/shared/permissions'
import { itemPath } from '~~/shared/data-items'
import type { DataItemDetail, DataItem } from '~~/shared/data-items'
import type { DatabaseValue } from '~~/shared/database'
import type { DocumentDTO, DatabaseItemDTO, MemberDTO } from '~~/shared/types'

definePageMeta({ layout: 'server', middleware: ['auth', 'manage-databases'], key: (route) => String(route.params.id) })

const { serverId } = useServer()
const { can } = useRoleGrants()
const isMobile = useIsMobile()
const { api } = useApi()
const route = useRoute()
const nav = useNavActions()
const qc = useQueryClient()
const toast = useToast()
const selectedId = computed(() => String(route.params.id))
const documentQ = useQuery({
  queryKey: computed(() => ['item', selectedId.value]),
  queryFn: () => api<{ item: DataItemDetail }>(`/api/items/${selectedId.value}`),
})
const activeDocument = computed(() =>
  documentQ.data.value?.item.id === selectedId.value ? documentQ.data.value.item : null,
)
const membersQ = useQuery({
  queryKey: computed(() => ['members', serverId.value]),
  queryFn: () => api<{ members: MemberDTO[] }>(`/api/servers/${serverId.value}/members`),
  enabled: computed(() => !!activeDocument.value?.databaseId),
})
const busy = ref(false)
async function invalidate() {
  await Promise.all(
    ['data-resources', 'items', 'database', 'data-references'].map((key) => qc.invalidateQueries({ queryKey: [key] })),
  )
}
async function patchProperty(fieldId: string, value: DatabaseValue) {
  if (busy.value || !(await save())) return
  busy.value = true
  try {
    const item = activeDocument.value!
    const result = await api<{ item: DatabaseItemDTO }>(`/api/items/${item.id}/properties`, {
      method: 'PATCH',
      body: { version: item.version, values: { [fieldId]: value } },
    })
    qc.setQueryData(['item', item.id], { item: { ...item, ...result.item } })
    await invalidate()
  } catch (error) {
    toast.add({ title: errorMessage(error), color: 'error' })
  } finally {
    busy.value = false
  }
}
async function createChild() {
  if (busy.value || !(await save())) return
  busy.value = true
  try {
    const result = await api<{ item: DataItemDetail }>(`/api/servers/${serverId.value}/items`, {
      method: 'POST',
      body: { parentId: selectedId.value },
    })
    await invalidate()
    await navigateTo(itemPath(result.item.id))
  } catch (error) {
    toast.add({ title: errorMessage(error), color: 'error' })
  } finally {
    busy.value = false
  }
}
function itemUpdated(item: DataItem | DocumentDTO) {
  qc.setQueryData(['item', item.id], { item: { ...activeDocument.value, ...item } })
  void invalidate()
}
const { title, content, dirty, saving, saveError, save, discard, cancelScheduledSave, scheduleSave } = useDocumentDraft(
  activeDocument,
  async (id, patch) => {
    const result = await api<{ item: DataItem }>(`/api/items/${id}`, { method: 'PATCH', body: patch })
    return result.item
  },
  itemUpdated,
)
const deleting = ref(false)
useDocumentCreateGuard(save)
const showDelete = ref(false)
const showReload = ref(false)

async function reloadDocument() {
  const result = await documentQ.refetch()
  if (result.error) {
    toast.add({ title: errorMessage(result.error), color: 'error' })
    return
  }
  discard()
  showReload.value = false
}

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
    await api(`/api/items/${document.id}`, { method: 'DELETE' })
    discard()
    showDelete.value = false
    qc.removeQueries({ queryKey: ['item', document.id] })
    await qc.invalidateQueries({ queryKey: ['data-resources'] })
    await navigateTo('/data', { replace: true })
    toast.add({ title: 'Document moved to Trash', color: 'success' })
  } catch (error) {
    toast.add({ title: errorMessage(error), color: 'error' })
  } finally {
    deleting.value = false
  }
}

function retryLoad() {
  return documentQ.refetch()
}
</script>

<template>
  <div class="flex h-full min-h-0 min-w-0 flex-col">
    <LayoutPageHeader
      icon="i-ph-file-text"
      :crumbs="
        activeDocument
          ? [{ label: 'Data', to: '/data' }, { label: title || activeDocument.title }]
          : [{ label: 'Data', to: '/data' }, { label: 'Pages' }]
      "
    >
      <template #actions>
        <DataMarkdownTransfer
          :document-id="activeDocument?.id"
          :save-draft="save"
          :writable="can(Permission.writeData)"
        />
        <span v-if="activeDocument" class="text-xs text-dimmed">{{
          saving ? 'Saving…' : saveError ? 'Not saved' : dirty ? 'Unsaved' : 'Saved'
        }}</span>
        <DataBookmarkButton
          v-if="activeDocument"
          :server-id="serverId"
          target-type="item"
          :target-id="activeDocument.id"
        />
        <DataDocumentHistory
          v-if="activeDocument"
          :document-id="activeDocument.id"
          :version="activeDocument.version"
          :writable="can(Permission.writeData)"
          :save-draft="save"
          @restored="itemUpdated"
        />
        <UButton
          v-if="activeDocument && can(Permission.manageDatabases)"
          color="neutral"
          variant="ghost"
          icon="i-ph-trash"
          aria-label="Delete document"
          :disabled="saving || deleting"
          @click="showDelete = true"
        />
        <UButton
          v-if="can(Permission.writeData)"
          icon="i-ph-plus"
          :label="isMobile ? undefined : 'Document'"
          aria-label="New document"
          :loading="nav.documentCreating.value"
          @click="nav.createDocumentOpen.value = true"
        />
      </template>
    </LayoutPageHeader>

    <div v-if="documentQ.isPending.value"><LayoutSkeleton variant="document" /></div>
    <LayoutLoadError v-else-if="documentQ.error.value" message="Page did not load." :retry="retryLoad" />
    <LayoutEmptyState
      v-else-if="!activeDocument"
      icon="i-ph-file-text"
      title="Page not found"
      description="Notes, specs and guides your team edits together, with a bookmark for the ones you keep coming back to."
    >
      <UButton
        v-if="can(Permission.writeData)"
        icon="i-ph-plus"
        label="Create first document"
        :loading="nav.documentCreating.value"
        @click="nav.createDocumentOpen.value = true"
      />
    </LayoutEmptyState>
    <main v-else class="min-h-0 flex-1 overflow-y-auto">
      <UAlert
        v-if="saveError"
        color="error"
        title="Page not saved"
        :description="errorMessage(saveError)"
        class="m-4 w-auto"
      >
        <template #actions>
          <UButton label="Retry save" color="error" variant="soft" :loading="saving" @click="save()" />
          <UButton
            label="Reload latest"
            color="neutral"
            variant="outline"
            :disabled="saving"
            @click="showReload = true"
          />
        </template>
      </UAlert>
      <div v-if="activeDocument.kind === 'canvas'" class="h-[65vh] min-h-96">
        <DataCanvasEditor :item-id="activeDocument.id" />
      </div>
      <div class="mx-auto w-full max-w-4xl px-5 py-8 sm:px-10">
        <DataItemLocation :item="activeDocument" :save-draft="save" :disabled="busy" @updated="itemUpdated" />
        <DataItemAppearance
          :item="activeDocument"
          :save-draft="save"
          :writable="can(Permission.writeData)"
          @updated="itemUpdated"
        />
        <UInput
          v-model="title"
          placeholder="Untitled"
          :disabled="nav.documentCreating.value"
          :readonly="!can(Permission.writeData)"
          variant="none"
          size="xl"
          aria-label="Page title"
          class="mb-5 w-full"
          :ui="{ base: 'px-0 text-3xl font-semibold' }"
          @update:model-value="scheduleSave"
        />
        <dl v-if="activeDocument.databaseId" class="mb-8 divide-y divide-default">
          <div
            v-for="field in activeDocument.fields"
            :key="field.id"
            class="grid grid-cols-[minmax(7rem,1fr)_3fr] items-center gap-4 py-2"
          >
            <dt class="text-sm text-muted">{{ field.name }}</dt>
            <dd>
              <DataFieldEditor
                :field="field"
                :value="activeDocument.values[field.id]"
                :members="membersQ.data.value?.members ?? []"
                :linked="activeDocument.linked"
                :disabled="busy || saving || !can(Permission.writeData)"
                @update="patchProperty(field.id, $event)"
              />
            </dd>
          </div>
        </dl>
        <UEditor
          v-model="content"
          :editable="can(Permission.writeData) && !nav.documentCreating.value"
          content-type="html"
          placeholder="Start writing…"
          class="min-h-64"
          @update:model-value="scheduleSave"
        >
          <template #default="{ editor }">
            <UEditorToolbar
              v-if="can(Permission.writeData)"
              :editor="editor"
              class="sticky top-0 z-10 mb-4 border-b border-default bg-default/95 py-2 backdrop-blur"
            />
          </template>
        </UEditor>
        <section class="my-8 space-y-2" aria-label="Child pages">
          <div class="flex items-center justify-between">
            <h2 class="text-sm font-medium text-muted">Pages inside</h2>
            <UButton
              v-if="can(Permission.writeData)"
              label="Add page"
              icon="i-ph-plus"
              variant="ghost"
              size="xs"
              :disabled="busy || saving"
              @click="createChild"
            />
          </div>
          <ULink
            v-for="child in activeDocument.children"
            :key="child.id"
            :to="itemPath(child.id)"
            class="block rounded border border-default p-3 hover:bg-elevated"
            >{{ child.icon || '↳' }} {{ child.title }}</ULink
          >
        </section>
        <DataReferences
          v-if="activeDocument"
          :id="activeDocument.id"
          type="item"
          :writable="can(Permission.writeData)"
        />
      </div>
    </main>

    <UModal v-model:open="showReload" title="Discard unsaved changes?">
      <template #body
        ><p class="text-sm text-muted">
          This replaces your draft with the latest saved document. Copy any text you want to keep first.
        </p></template
      >
      <template #footer>
        <UButton color="neutral" variant="ghost" label="Cancel" @click="showReload = false" />
        <UButton
          color="error"
          label="Discard and reload"
          :loading="documentQ.isFetching.value"
          @click="reloadDocument"
        />
      </template>
    </UModal>
    <UModal v-model:open="showDelete" title="Move document to Trash?">
      <template #body><p class="text-sm text-muted">You can restore this from Trash in Data.</p></template>
      <template #footer>
        <UButton color="neutral" variant="ghost" label="Cancel" @click="showDelete = false" />
        <UButton color="error" label="Move to Trash" :loading="deleting" @click="removeDocument" />
      </template>
    </UModal>
  </div>
</template>
