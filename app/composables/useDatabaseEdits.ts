import { reactive } from 'vue'
import type { DatabaseValue } from '~~/shared/database'
import type { DatabaseItemDTO } from '~~/shared/types'

type Patch = { title?: string; values?: Record<string, DatabaseValue> }
type Edit = { item: DatabaseItemDTO; patch: Patch; saving: boolean; error: unknown }

export function useDatabaseEdits(persist: (id: string, patch: Patch & { version: number }) => Promise<DatabaseItemDTO>, onSaved: (item: DatabaseItemDTO) => void) {
  const edits = reactive(new Map<string, Edit>())
  const pending = new Map<string, Promise<void>>()

  function save(id: string): Promise<void> {
    const running = pending.get(id)
    if (running) return running
    const edit = edits.get(id)
    if (!edit) return Promise.resolve()
    const run = async () => {
      edit.saving = true
      edit.error = null
      try {
        while (edit.patch.title !== undefined || Object.keys(edit.patch.values ?? {}).length) {
          const sent = { ...edit.patch, values: { ...edit.patch.values } }
          const saved = await persist(id, { ...sent, version: edit.item.version })
          edit.item = saved
          if (edit.patch.title === sent.title) delete edit.patch.title
          edit.patch.values = Object.fromEntries(Object.entries(edit.patch.values ?? {}).filter(([key, value]) => sent.values[key] !== value))
          onSaved(saved)
        }
      }
      catch (error) { edit.error = error }
      finally { edit.saving = false; pending.delete(id) }
    }
    const promise = Promise.resolve().then(run)
    pending.set(id, promise)
    return promise
  }

  function update(item: DatabaseItemDTO, patch: Patch) {
    let edit = edits.get(item.id)
    if (!edit) {
      edits.set(item.id, { item, patch: {}, saving: false, error: null })
      edit = edits.get(item.id)!
    }
    if (!edit.saving && !edit.error && item.version > edit.item.version) edit.item = item
    edit.patch = { ...edit.patch, ...patch, values: { ...edit.patch.values, ...patch.values } }
    if (!edit.error) void save(item.id)
  }

  function display(item: DatabaseItemDTO): DatabaseItemDTO {
    const edit = edits.get(item.id)
    if (!edit) return item
    const base = item.version > edit.item.version ? item : edit.item
    return { ...base, ...edit.patch, values: { ...base.values, ...edit.patch.values } }
  }

  function discard(item: DatabaseItemDTO) {
    if (edits.get(item.id)?.saving) return
    edits.set(item.id, { item, patch: {}, saving: false, error: null })
  }

  function retry(item: DatabaseItemDTO) {
    const edit = edits.get(item.id)
    if (edit && !edit.saving) edit.item = item
    return save(item.id)
  }

  const isDirty = () => [...edits.values()].some(edit => edit.saving || edit.patch.title !== undefined || Object.keys(edit.patch.values ?? {}).length > 0)
  async function flush() {
    if ([...edits.values()].some(edit => edit.error)) return false
    await Promise.all([...edits.keys()].map(save))
    return !isDirty()
  }

  return { edits, update, save, display, discard, retry, isDirty, flush }
}
