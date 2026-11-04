<script setup lang="ts">
import { useQueryClient } from '@tanstack/vue-query'
import type { DatabaseFieldDTO } from '~~/shared/types'
import type { DatabaseValue } from '~~/shared/database'
import { csvFieldValue, parseDataCsv, CSV_MAX_BYTES } from '~~/shared/data-csv'
import { downloadDataFile } from '~/utils/data-download'

const props = defineProps<{ databaseId: string; viewId: string; search: string; fields: DatabaseFieldDTO[]; writable: boolean; dateFrom?: string; dateTo?: string }>()
const { api } = useApi()
const qc = useQueryClient()
const open = ref(false)
const busy = ref(false)
const error = ref('')
const csv = ref<string[][]>([])
const mapping = ref<string[]>([])
const importId = ref('')
const issues = ref<Record<number, string>>({})
const checked = ref(false)
const completed = ref(new Set<number>())
const safeExport = ref(true)
const fileKey = ref(0)
function resetImport() {
  csv.value = []; mapping.value = []; completed.value = new Set(); issues.value = {}; error.value = ''; checked.value = false; importId.value = ''; fileKey.value++
}
const choices = computed(() => [{ label: 'Skip', value: '__skip__' }, { label: 'Title', value: 'title' }, ...props.fields.map(field => ({ label: field.name, value: field.id }))])
const mapped = computed(() => {
  const fields = new Map(props.fields.map(field => [field.id, field]))
  return csv.value.slice(1).map((cells, index) => {
    try {
      const selected = mapping.value.filter(id => id && id !== '__skip__')
      if (!selected.includes('title')) throw new Error('Map one column to Title')
      if (new Set(selected).size !== selected.length) throw new Error('Map each field only once')
      let title = ''; const values: Record<string, DatabaseValue> = {}
      for (const [column, id] of mapping.value.entries()) {
        if (!id || id === '__skip__') continue
        if (id === 'title') title = (cells[column] ?? '').trim()
        else { const field = fields.get(id); if (!field) throw new Error('A mapped field no longer exists'); values[id] = csvFieldValue(field, cells[column] ?? '') }
      }
      if (!title || title.length > 500) throw new Error('Title must contain 1–500 characters')
      return { index, row: { requestId: `${importId.value}:${index}`, title, values }, error: null }
    }
    catch (cause) { return { index, row: null, error: errorMessage(cause) } }
  })
})
watch(mapping, () => { checked.value = false; issues.value = {} }, { deep: true })
watch(() => props.databaseId, () => { open.value = false; resetImport() })
async function chooseFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  error.value = ''; checked.value = false; issues.value = {}; completed.value = new Set()
  try {
    if (file.size > CSV_MAX_BYTES) throw new Error('Choose a CSV file no larger than 2 MB')
    csv.value = parseDataCsv(await file.text())
    mapping.value = csv.value[0]!.map(header => header.toLowerCase() === 'title' ? 'title' : props.fields.find(field => field.name.toLowerCase() === header.toLowerCase())?.id ?? '__skip__')
    importId.value = crypto.randomUUID()
  }
  catch (cause) { csv.value = []; error.value = errorMessage(cause) }
}
async function submit(preview: boolean) {
  if (busy.value) return
  const databaseId = props.databaseId
  const generation = importId.value
  busy.value = true; error.value = ''
  try {
    issues.value = Object.fromEntries(mapped.value.filter(entry => entry.error).map(entry => [entry.index, entry.error!]))
    const candidates = mapped.value.filter(entry => entry.row && !completed.value.has(entry.index))
    for (let offset = 0; offset < candidates.length; offset += 50) {
      if (props.databaseId !== databaseId || importId.value !== generation) break
      const chunk = candidates.slice(offset, offset + 50)
      const response = await api<{ results: Array<{ index: number; ok: boolean; error?: { message: string } }> }>(`/api/databases/${databaseId}/import`, { method: 'POST', body: { preview, rows: chunk.map(entry => entry.row) } })
      if (props.databaseId !== databaseId || importId.value !== generation) break
      for (const result of response.results) {
        const index = chunk[result.index]!.index
        if (!result.ok) issues.value[index] = result.error?.message ?? 'Check this row'
        else if (!preview) completed.value.add(index)
      }
    }
    if (props.databaseId === databaseId && importId.value === generation) checked.value = true
    if (!preview) await Promise.all([qc.invalidateQueries({ queryKey: ['database', databaseId] }), qc.invalidateQueries({ queryKey: ['data-resources'] })])
  }
  catch (cause) { error.value = errorMessage(cause) }
  finally { busy.value = false }
}
async function download() {
  busy.value = true; error.value = ''
  try {
    const contents = await api<string>(`/api/databases/${props.databaseId}/export`, { query: { viewId: props.viewId, search: props.search, dateFrom: props.dateFrom, dateTo: props.dateTo, spreadsheetSafe: String(safeExport.value) } })
    downloadDataFile(contents, 'records.csv', 'text/csv;charset=utf-8')
  }
  catch (cause) { error.value = errorMessage(cause) }
  finally { busy.value = false }
}
</script>

<template>
  <UButton label="CSV" icon="i-ph-arrows-down-up" color="neutral" variant="ghost" @click="open = true" />
  <UModal v-model:open="open" title="Import and export CSV" :dismissible="!busy">
    <template #body>
      <UAlert v-if="error" :description="error" color="error" class="mb-4" />
      <p class="mb-3 text-sm text-muted">Export this view's fields, filters and sort, including your search. Lists use JSON arrays; Person and Relation entries use IDs.</p>
      <UCheckbox v-model="safeExport" label="Escape spreadsheet formulas with an apostrophe" />
      <UButton label="Export current view" icon="i-ph-download-simple" :loading="busy" class="mt-3" @click="download" />
      <template v-if="writable">
        <hr class="my-5 border-default">
        <UFormField label="Import CSV" description="Up to 1,000 records and 2 MB. Map columns to existing fields, then check the rows before importing."><input :key="fileKey" type="file" accept=".csv,text/csv" :disabled="busy || completed.size > 0" class="block w-full text-sm" @change="chooseFile"></UFormField>
        <div v-if="csv.length" class="mt-4 space-y-3">
          <UFormField v-for="(header, index) in csv[0]" :key="index" :label="header || `Column ${index + 1}`"><USelect v-model="mapping[index]" :items="choices" :disabled="busy || completed.size > 0" class="w-full" /></UFormField>
          <p class="text-sm">{{ csv.length - 1 }} rows · {{ completed.size }} imported · {{ Object.keys(issues).length }} errors</p>
          <ul v-if="Object.keys(issues).length" class="max-h-40 overflow-y-auto text-sm text-error"><li v-for="(message, index) in issues" :key="index">Row {{ Number(index) + 2 }}: {{ message }}</li></ul>
          <div class="flex flex-wrap gap-2"><UButton label="Check rows" color="neutral" variant="soft" :loading="busy" @click="submit(true)" /><UButton label="Import valid rows" :disabled="!checked || completed.size === csv.length - 1" :loading="busy" @click="submit(false)" /></div>
          <UButton v-if="completed.size" label="Start another import" color="neutral" variant="ghost" :disabled="busy" @click="resetImport" />
          <p class="text-xs text-muted">Successful rows are kept when another row fails. Retrying this import skips rows already created.</p>
        </div>
      </template>
    </template>
  </UModal>
</template>
