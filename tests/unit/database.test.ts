import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { INIT_SQL } from '../../server/utils/db'
import { DatabaseSlotCounts, databaseSlots, isDatabaseSlot, normalizeDatabaseOptions } from '../../shared/database'
import { loadDatabasePage } from '../../server/utils/database-views'
import { d1 } from '../helpers/sqlite-d1'

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

describe('fresh server Data schema', () => {
  it('creates typed slots and loads semantic records without physical slot leakage', async () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec(INIT_SQL)
    db.exec("INSERT INTO auth_users (id,name,email,username) VALUES ('user-1','Alice','alice@example.com','alice')")
    db.exec("INSERT INTO users (id,display_name) VALUES ('user-1','Alice')")

    db.exec("INSERT INTO database_definitions (id, name, created_by) VALUES ('db-1', 'Leads', 'user-1')")
    db.exec("INSERT INTO database_fields (id, database_id, name, type, slot, created_by) VALUES ('field-1', 'db-1', 'Company', 'text', 'text_1', 'user-1')")
    db.exec("INSERT INTO database_items (id, database_id, title, created_by, text_1, number_1, boolean_1) VALUES ('item-1', 'db-1', 'Acme', 'user-1', 'Acme Inc', 42.5, 1)")

    expect(db.prepare('SELECT text_1, number_1, boolean_1 FROM database_items WHERE id = ?').get('item-1')).toEqual({ text_1: 'Acme Inc', number_1: 42.5, boolean_1: 1 })
    const page = await loadDatabasePage({ DB: d1(db) } as never, 'db-1', { page: 1, pageSize: 100 })
    expect(page.database.fields).toMatchObject([{ id: 'field-1', name: 'Company' }])
    expect(page.items).toMatchObject([{ id: 'item-1', values: { 'field-1': 'Acme Inc' } }])
    expect(page.database.fields[0]).not.toHaveProperty('slot')
    expect(page.items[0]).not.toHaveProperty('text_1')
    expect(() => db.exec("INSERT INTO database_fields (id, database_id, name, type, slot, created_by) VALUES ('field-2', 'db-1', 'Duplicate', 'text', 'text_1', 'user-1')")).toThrow()
  })
})
