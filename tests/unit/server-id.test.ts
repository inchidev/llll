import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { getServerId } from '../../shared/server-id'
import { INIT_SQL } from '../../server/utils/db'
it('allocates one UUIDv4 before setup, preserves it under concurrent discovery, and gives another Server a different ID', async () => {
  const databases = [new DatabaseSync(':memory:'), new DatabaseSync(':memory:')]
  function d1(db: DatabaseSync) {
    return {
      prepare(sql: string) {
        let values: (string | number)[] = []
        const statement = {
          bind(...args: (string | number)[]) {
            values = args
            return statement
          },
          async first() {
            return db.prepare(sql).get(...values) || null
          },
          async run() {
            db.prepare(sql).run(...values)
          },
        }
        return statement
      },
    } as never
  }
  try {
    for (const db of databases) db.exec(INIT_SQL)
    const db = d1(databases[0]!)
    const ids = await Promise.all([
      getServerId(db),
      getServerId(db),
      getServerId(db),
    ])
    expect(new Set(ids).size).toBe(1)
    expect(ids[0]).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    )
    expect(await getServerId(d1(databases[1]!))).not.toBe(ids[0])
    expect(await getServerId(db)).toBe(ids[0])
    expect(() =>
      databases[0]!.exec(
        "INSERT INTO server(id,name,owner_id) VALUES('main','Invalid','owner')",
      ),
    ).toThrow()
  } finally {
    for (const db of databases) db.close()
  }
})
