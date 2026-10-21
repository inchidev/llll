import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

export function d1(database: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      let values: SQLInputValue[] = []
      const statement = {
        bind(...next: SQLInputValue[]) { values = next; return statement },
        async first<T>() { return (database.prepare(sql).get(...values) as T | undefined) ?? null },
        async all<T>() { return { results: database.prepare(sql).all(...values) as T[] } },
        async raw() { const query = database.prepare(sql); query.setReturnArrays(true); return query.all(...values) },
        async run() { return { success: true, meta: database.prepare(sql).run(...values) } },
      }
      return statement
    },
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      database.exec('BEGIN')
      try { const values = []; for (const statement of statements) values.push(await statement.run()); database.exec('COMMIT'); return values }
      catch (error) { database.exec('ROLLBACK'); throw error }
    },
  } as unknown as D1Database
}

