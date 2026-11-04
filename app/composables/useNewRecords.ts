import { ref } from 'vue'
import type { DatabaseValue } from '~~/shared/database'
import type { DatabaseItemDTO } from '~~/shared/types'

type Values = Record<string, DatabaseValue>
type PendingRecord = { key: number; databaseId: string; title: string }

/**
 * Records typed into the New record row. Each one shows at once as a pending row
 * and is created one after another, so they keep the order they were typed in.
 * The database and starting values are fixed when the title is entered: the page
 * may change view or reload while earlier records are still saving.
 */
export function useNewRecords(
  create: (databaseId: string, title: string, values: Values) => Promise<DatabaseItemDTO>,
  handlers: {
    onCreated: (databaseId: string, item: DatabaseItemDTO) => void
    onFailed: (title: string, error: unknown) => void
    onIdle?: () => void
  },
) {
  const pending = ref<PendingRecord[]>([])
  let nextKey = 0
  let queue: Promise<void> = Promise.resolve()

  async function run(record: PendingRecord, values: Values) {
    try {
      handlers.onCreated(record.databaseId, await create(record.databaseId, record.title, values))
    }
    catch (error) {
      handlers.onFailed(record.title, error)
    }
    finally {
      pending.value = pending.value.filter(entry => entry.key !== record.key)
      if (!pending.value.length) handlers.onIdle?.()
    }
  }

  function submit(databaseId: string, title: string, values: Values = {}): Promise<void> {
    const record = { key: ++nextKey, databaseId, title }
    pending.value = [...pending.value, record]
    queue = queue.then(() => run(record, values))
    return queue
  }

  return { pending, submit }
}
