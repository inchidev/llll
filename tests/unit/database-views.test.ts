import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { defaultDatabaseViewConfig } from '../../shared/database'
import { INIT_SQL } from '../../server/utils/db'
import { loadDatabasePage, normalizeDatabaseViewConfig, validCalendarRange } from '../../server/utils/database-views'

function d1(sqlite: DatabaseSync): D1Database {
  function prepare(sql: string) {
    let values: unknown[] = []
    const statement = {
      bind(...next: unknown[]) { values = next; return statement },
      async first<T>() { return sqlite.prepare(sql).get(...values) as T | null },
      async all<T>() { return { results: sqlite.prepare(sql).all(...values) as T[] } },
      async run() { sqlite.prepare(sql).run(...values); return { success: true } },
    }
    return statement
  }
  return {
    prepare,
    async batch(statements: Array<ReturnType<typeof prepare>>) {
      const results = []
      for (const statement of statements) results.push(await statement.all())
      return results
    },
  } as unknown as D1Database
}

function fixture() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(INIT_SQL)
  sqlite.exec(`
    INSERT INTO roles (id, key, name, permissions_bitmask) VALUES ('owner-role', 'owner', 'Owner', 1023);
    INSERT INTO identity_keys (id, name, email) VALUES ('owner', 'Owner', 'owner@example.com');
    INSERT INTO users (id, kind, display_name, status, role_id, joined_at) VALUES ('owner', 'human', 'Owner', 'active', 'owner-role', CURRENT_TIMESTAMP);
    INSERT INTO database_definitions (id, name, created_by) VALUES ('leads', 'Leads', 'owner');
    INSERT INTO database_fields (id, database_id, name, type, slot, config_json, created_by) VALUES
      ('status', 'leads', 'Status', 'select', 'select_1', '{"options":["Open","Won"]}', 'owner'),
      ('score', 'leads', 'Score', 'number', 'number_1', '{}', 'owner'),
      ('due', 'leads', 'Due', 'date', 'date_1', '{}', 'owner');
    INSERT INTO database_items (id, database_id, title, select_1, number_1, date_1, created_by) VALUES
      ('one', 'leads', 'Acme', 'Open', 3, '2026-09-10', 'owner'),
      ('two', 'leads', 'Beta', 'Won', 9, '2026-09-11', 'owner'),
      ('three', 'leads', 'Atlas', 'Open', 7, '2026-09-12', 'owner');
  `)
  return sqlite
}

describe('database views', () => {
  it('creates a default view for every database and queries a semantic saved view', async () => {
    const sqlite = fixture()
    expect(sqlite.prepare('SELECT name, layout FROM database_views WHERE database_id = ?').get('leads')).toEqual({ name: 'All records', layout: 'table' })
    const config = { ...defaultDatabaseViewConfig(), filters: [{ fieldId: 'status', operator: 'equals' as const, value: 'Open' }], sorts: [{ fieldId: 'score', direction: 'desc' as const }] }
    sqlite.prepare(`INSERT INTO database_views (id, database_id, name, layout, config_json, position, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('open', 'leads', 'Open leads', 'list', JSON.stringify(config), 2048, 'owner')

    const page = await loadDatabasePage({ DB: d1(sqlite) } as never, 'leads', { viewId: 'open', page: 1, pageSize: 100 })
    expect(page.view).toMatchObject({ id: 'open', name: 'Open leads', layout: 'list' })
    expect(page.items.map(item => item.id)).toEqual(['three', 'one'])
    expect(page.total).toBe(2)
    expect(page.items[0]).not.toHaveProperty('select_1')

    sqlite.prepare(`INSERT INTO database_items (id, database_id, title, created_by) VALUES ('percent', 'leads', '100% ready', 'owner')`).run()
    const searched = await loadDatabasePage({ DB: d1(sqlite) } as never, 'leads', { page: 1, pageSize: 100, search: '%' })
    expect(searched.items.map(item => item.id)).toEqual(['percent'])
    await expect(loadDatabasePage({ DB: d1(sqlite) } as never, 'leads', { viewId: 'missing', page: 1, pageSize: 100 })).rejects.toThrow()
    sqlite.close()
  })

  it('validates layout fields and removes bookmarks when targets are deleted', () => {
    const sqlite = fixture()
    const fields = [
      { id: 'status', databaseId: 'leads', name: 'Status', type: 'select' as const, slot: 'select_1', options: ['Open', 'Won'], position: 0, createdAt: '', updatedAt: '' },
    ]
    expect(() => normalizeDatabaseViewConfig(defaultDatabaseViewConfig(), fields, 'board', true)).toThrow()
    expect(normalizeDatabaseViewConfig(defaultDatabaseViewConfig(), fields, 'table', true).visibleFieldIds).toBeNull()
    expect(normalizeDatabaseViewConfig({ ...defaultDatabaseViewConfig(), visibleFieldIds: [] }, fields, 'table', true).visibleFieldIds).toEqual([])
    // Column widths keep known columns only, clamped to the allowed range.
    expect(normalizeDatabaseViewConfig({ ...defaultDatabaseViewConfig(), columnWidths: { title: 20, status: 300.4, gone: 200, bad: 'wide' } }, fields, 'table', true).columnWidths)
      .toEqual({ title: 80, status: 300 })
    expect(normalizeDatabaseViewConfig({ ...defaultDatabaseViewConfig(), columnWidths: { status: 5000 } }, fields, 'table').columnWidths).toEqual({ status: 640 })
    expect(normalizeDatabaseViewConfig({ visibleFieldIds: null }, fields, 'table').columnWidths).toEqual({})
    const board = { ...defaultDatabaseViewConfig(), groupFieldId: 'status' }
    expect(normalizeDatabaseViewConfig(board, fields, 'board', true).groupFieldId).toBe('status')
    expect(() => normalizeDatabaseViewConfig({ ...board, filters: [{ fieldId: 'status', operator: 'equals', value: 'Missing' }] }, fields, 'board', true)).toThrow()

    sqlite.exec(`
      INSERT INTO documents (id, title, created_by) VALUES ('doc', 'Brief', 'owner');
      INSERT INTO data_bookmarks (user_id, target_type, target_id) VALUES ('owner', 'document', 'doc');
      DELETE FROM documents WHERE id = 'doc';
    `)
    expect(sqlite.prepare('SELECT COUNT(*) as count FROM data_bookmarks').get()).toEqual({ count: 0 })

    sqlite.exec(`
      INSERT INTO data_bookmarks (user_id, target_type, target_id) VALUES ('owner', 'database_view', 'default:leads');
      DELETE FROM database_definitions WHERE id = 'leads';
    `)
    expect(sqlite.prepare('SELECT COUNT(*) as count FROM data_bookmarks').get()).toEqual({ count: 0 })
    sqlite.close()
  })

  it('limits calendar data to its visible range and returns complete board group totals', async () => {
    expect(validCalendarRange('2026-09-12', '2026-09-11')).toBe(false)
    expect(validCalendarRange('2026-09-11', '2026-09-12')).toBe(true)
    const sqlite = fixture()
    const calendar = {
      ...defaultDatabaseViewConfig(),
      dateFieldId: 'due',
    }
    const board = {
      ...defaultDatabaseViewConfig(),
      groupFieldId: 'status',
    }
    sqlite.prepare(`INSERT INTO database_views (id, database_id, name, layout, config_json, position, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('calendar', 'leads', 'Calendar', 'calendar', JSON.stringify(calendar), 2048, 'owner')
    sqlite.prepare(`INSERT INTO database_views (id, database_id, name, layout, config_json, position, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('board', 'leads', 'Board', 'board', JSON.stringify(board), 3072, 'owner')

    const calendarPage = await loadDatabasePage({ DB: d1(sqlite) } as never, 'leads', {
      viewId: 'calendar',
      page: 1,
      pageSize: 100,
      dateFrom: '2026-09-11',
      dateTo: '2026-09-12',
    })
    expect(calendarPage.items.map(item => item.id)).toEqual(['three', 'two'])
    expect(calendarPage.total).toBe(2)

    const boardPage = await loadDatabasePage({ DB: d1(sqlite) } as never, 'leads', { viewId: 'board', page: 1, pageSize: 1 })
    expect(boardPage.items).toHaveLength(1)
    expect(boardPage.groupCounts).toEqual({ Open: 2, Won: 1 })
    sqlite.close()
  })
})
