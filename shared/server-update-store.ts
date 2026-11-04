import { emptyUpdateRecord, readUpdateRecord, type UpdateStore } from './server-updates'

type ControlRow = { payload: string; revision: number }
type Query = (sql: string, params: (string | number)[]) => Promise<ControlRow[]>

/** The same atomic D1 revision check is used by the Worker binding and Git Build REST API. */
export function createUpdateStore(query: Query): UpdateStore {
  return {
    async read() {
      const row = (await query('SELECT payload, revision FROM server_update_control WHERE id = 1', []))[0]
      return row ? { value: readUpdateRecord(row.payload), revision: row.revision } : { value: emptyUpdateRecord(), revision: null }
    },
    async write(value, revision) {
      const payload = JSON.stringify(value)
      const rows = revision === null
        ? await query('INSERT INTO server_update_control (id, revision, payload) VALUES (1, 1, ?) ON CONFLICT(id) DO NOTHING RETURNING revision', [payload])
        : await query('UPDATE server_update_control SET payload = ?, revision = revision + 1 WHERE id = 1 AND revision = ? RETURNING revision', [payload, revision])
      return rows.length === 1
    },
  }
}
