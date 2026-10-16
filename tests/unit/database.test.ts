import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import migrationSql from '../fixtures/legacy-migrations/0015_workspace_databases.sql?raw'
import { DatabaseSlotCounts, databaseSlots, isDatabaseSlot, normalizeDatabaseOptions } from '../../shared/database'
import { loadDatabases } from '../../server/utils/database-data'

function d1(database: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      let values: unknown[] = []
      const statement = {
        bind(...next: unknown[]) {
          values = next
          return statement
        },
        async all<T>() {
          return { results: database.prepare(sql).all(...values) as T[] }
        },
      }
      return statement
    },
  } as unknown as D1Database
}

describe('database field slots', () => {
  it('allocates bounded typed columns', () => {
    expect(databaseSlots('text')).toHaveLength(DatabaseSlotCounts.text)
    expect(databaseSlots('text')[0]).toBe('text_1')
    expect(databaseSlots('number').at(-1)).toBe(`number_${DatabaseSlotCounts.number}`)
  })

  it('rejects columns outside the declared type pool', () => {
    expect(isDatabaseSlot('boolean', 'boolean_1')).toBe(true)
    expect(isDatabaseSlot('boolean', 'text_1')).toBe(false)
    expect(isDatabaseSlot('boolean', 'boolean_99')).toBe(false)
  })

  it('normalizes select options without case-insensitive duplicates', () => {
    expect(normalizeDatabaseOptions([' New ', 'new', '', 'Qualified'])).toEqual(['New', 'Qualified'])
  })
})

describe('workspace database migration', () => {
  it('creates typed slots, loads semantic records, and upgrades admin authority', async () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('CREATE TABLE users (id text PRIMARY KEY NOT NULL)')
    db.exec('CREATE TABLE roles (key text PRIMARY KEY NOT NULL, permissions_bitmask integer NOT NULL)')
    db.exec("INSERT INTO users (id) VALUES ('user-1')")
    db.exec("INSERT INTO roles (key, permissions_bitmask) VALUES ('admin', 0), ('member', 0)")
    for (const statement of migrationSql.split('--> statement-breakpoint').map(value => value.trim()).filter(Boolean)) db.exec(statement)

    db.exec("INSERT INTO database_definitions (id, name, created_by) VALUES ('db-1', 'Leads', 'user-1')")
    db.exec("INSERT INTO database_fields (id, database_id, name, type, slot, created_by) VALUES ('field-1', 'db-1', 'Company', 'text', 'text_1', 'user-1')")
    db.exec("INSERT INTO database_items (id, database_id, title, created_by, text_1, number_1, boolean_1) VALUES ('item-1', 'db-1', 'Acme', 'user-1', 'Acme Inc', 42.5, 1)")

    expect(db.prepare('SELECT text_1, number_1, boolean_1 FROM database_items WHERE id = ?').get('item-1')).toEqual({ text_1: 'Acme Inc', number_1: 42.5, boolean_1: 1 })
    await expect(loadDatabases({ DB: d1(db) } as never)).resolves.toEqual([
      expect.objectContaining({
        id: 'db-1',
        fields: [expect.objectContaining({ id: 'field-1', name: 'Company' })],
        items: [expect.objectContaining({ id: 'item-1', values: { 'field-1': 'Acme Inc' } })],
      }),
    ])
    const [publicDatabase] = await loadDatabases({ DB: d1(db) } as never)
    expect(publicDatabase!.fields[0]).not.toHaveProperty('slot')
    expect(publicDatabase!.items[0]).not.toHaveProperty('text_1')
    expect(() => db.exec("INSERT INTO database_fields (id, database_id, name, type, slot, created_by) VALUES ('field-2', 'db-1', 'Duplicate', 'text', 'text_1', 'user-1')")).toThrow()
    expect(db.prepare("SELECT permissions_bitmask FROM roles WHERE key = 'admin'").get()).toEqual({ permissions_bitmask: 512 })
    expect(db.prepare("SELECT permissions_bitmask FROM roles WHERE key = 'member'").get()).toEqual({ permissions_bitmask: 0 })
  })
})
