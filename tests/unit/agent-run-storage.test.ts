import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { deleteRunBlob, getRunBlob, putRunBlob } from '../../workers/agent-run-storage'

it('atomically stores and replaces multi-megabyte Unicode archives in bounded SQLite rows', async () => {
  const db = new DatabaseSync(':memory:')
  const storage = {
    sql: { exec(query: string, ...args: Array<string | number>) {
      const statement = db.prepare(query)
      if (statement.columns().length) return { toArray: () => statement.all(...args) }
      statement.run(...args)
    } },
    transactionSync<T>(callback: () => T) {
      db.exec('BEGIN')
      try { const result = callback(); db.exec('COMMIT'); return result } catch (error) { db.exec('ROLLBACK'); throw error }
    },
    get: async () => undefined,
    delete: async () => false,
  } as unknown as DurableObjectStorage
  try {
    const archive = { transcript: '𠮷а中'.repeat(210000) }
    await putRunBlob(storage, 'archive', archive)
    expect(await getRunBlob(storage, 'archive')).toEqual(archive)
    for (const row of db.prepare('SELECT value FROM l4_run_blobs').all()) {
      expect(new TextEncoder().encode(String(row.value)).byteLength).toBeLessThan(128 * 1024)
    }
    await putRunBlob(storage, 'archive', { transcript: 'Short' })
    expect(db.prepare('SELECT COUNT(*) AS count FROM l4_run_blobs').get()?.count).toBe(1)
    expect(await getRunBlob(storage, 'archive')).toEqual({ transcript: 'Short' })
    await deleteRunBlob(storage, 'archive')
    expect(db.prepare('SELECT COUNT(*) AS count FROM l4_run_blobs').get()?.count).toBe(0)
  } finally { db.close() }
})
