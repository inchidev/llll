import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { expect, it, vi } from 'vitest'
import { ensureMigrated, INIT_SQL } from '../../server/utils/db'

function binding(sqlite: DatabaseSync) {
  const exec = vi.fn(async (sql: string) => { sqlite.exec(sql) })
  const db = {
    exec,
    prepare(sql: string) {
      let values: SQLInputValue[] = []
      const statement = {
        bind(...args: SQLInputValue[]) { values = args; return statement },
        async first() { return sqlite.prepare(sql).get(...values) || null },
      }
      return statement
    },
  }
  return { db: db as unknown as D1Database, exec }
}

it('bootstraps a fresh database once and accepts its explicit schema marker', async () => {
  const sqlite = new DatabaseSync(':memory:')
  try {
    const { db, exec } = binding(sqlite)
    await expect(ensureMigrated(db)).resolves.toBe(true)
    await expect(ensureMigrated(db)).resolves.toBe(true)
    expect(exec).toHaveBeenCalledTimes(1)
    expect(sqlite.prepare('SELECT version FROM server_schema').get()).toMatchObject({ version: 'server-v1' })
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  }
  finally { sqlite.close() }
})

it('refuses a populated database without the schema marker without changing it', async () => {
  const sqlite = new DatabaseSync(':memory:')
  try {
    sqlite.exec("CREATE TABLE accounts(id TEXT); INSERT INTO accounts VALUES('preserve')")
    const { db, exec } = binding(sqlite)
    await expect(ensureMigrated(db)).rejects.toThrow('fresh server-v1 database')
    expect(exec).not.toHaveBeenCalled()
    expect(sqlite.prepare('SELECT * FROM accounts').all()).toEqual([{ id: 'preserve' }])
    expect(sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get()).toMatchObject({ n: 1 })
  }
  finally { sqlite.close() }
})

it('ships only the current schema and no mirrored identities or obsolete Agent runtime fields', () => {
  const sqlite = new DatabaseSync(':memory:')
  try {
    sqlite.exec(INIT_SQL)
    const objects = sqlite.prepare("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL").all()
    expect(JSON.stringify(objects)).not.toMatch(/workspace|installation|identity_keys|computer_id/i)
    expect(sqlite.prepare("PRAGMA table_info('auth_accounts')").all().map(row => row.name)).not.toContain('issuer')
    expect(sqlite.prepare("PRAGMA table_info('users')").all().map(row => row.name)).toContain('kind')
  }
  finally { sqlite.close() }
})
