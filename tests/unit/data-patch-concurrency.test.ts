import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'

const context = vi.hoisted(() => ({
  sqlite: null as DatabaseSync | null,
  id: '',
  body: {} as Record<string, unknown>,
  beforeUpdate: undefined as (() => void) | undefined,
  afterWrite: undefined as (() => void) | undefined,
}))

vi.mock('../../server/utils/guards', () => ({ requireMember: async () => ({
  user: { id: 'owner' },
  authorization: {
    workspaceId: 'main',
    principal: { id: 'owner', kind: 'human', roleId: 'role', roleName: 'Owner', permissions: 1023, isOwner: true },
    credential: { kind: 'session' },
  },
}) }))
vi.mock('../../server/utils/messages', () => ({ writeAudit: async () => context.afterWrite?.() }))
vi.mock('../../server/utils/cf', () => ({
  fail: (statusCode: number, code: string, message: string) => { throw Object.assign(new Error(message), { statusCode, code }) },
  cf: () => ({ env: { DB: {
    prepare(sql: string) {
      let values: SQLInputValue[] = []
      const statement = {
        bind(...args: SQLInputValue[]) { values = args; return statement },
        async first() {
          if (sql.startsWith('UPDATE ')) context.beforeUpdate?.()
          return context.sqlite!.prepare(sql).get(...values) ?? null
        },
        async all() { return { results: context.sqlite!.prepare(sql).all(...values) } },
        async run() {
          if (sql.startsWith('UPDATE ')) context.beforeUpdate?.()
          return { meta: context.sqlite!.prepare(sql).run(...values) }
        },
      }
      return statement
    },
  } } }),
}))

beforeAll(() => {
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('getRouterParam', () => context.id)
  vi.stubGlobal('readBody', async () => context.body)
})
afterAll(() => vi.unstubAllGlobals())

beforeEach(() => {
  context.sqlite = new DatabaseSync(':memory:')
  context.sqlite.exec(INIT_SQL)
  context.sqlite.exec(`
    INSERT INTO roles (id, key, name, permissions_bitmask) VALUES ('role', 'owner', 'Owner', 1023);
    INSERT INTO identity_keys (id, name, email) VALUES ('owner', 'Owner', 'owner@example.com');
    INSERT INTO users (id, display_name, status, role_id, joined_at) VALUES ('owner', 'Owner', 'active', 'role', CURRENT_TIMESTAMP);
    INSERT INTO documents (id, title, content, created_by) VALUES ('doc', 'Document', 'Initial', 'owner');
    INSERT INTO canvases (id, title, created_by) VALUES ('canvas', 'Initial', 'owner');
    INSERT INTO canvas_nodes (id, canvas_id, content, created_by) VALUES ('node', 'canvas', 'Initial', 'owner');
    INSERT INTO database_definitions (id, name, created_by) VALUES ('database', 'Database', 'owner');
    INSERT INTO database_fields (id, database_id, name, type, slot, created_by) VALUES ('field', 'database', 'Text', 'text', 'text_1', 'owner');
    INSERT INTO database_items (id, database_id, title, text_1, created_by) VALUES ('item', 'database', 'Record', 'Initial', 'owner');
  `)
  context.beforeUpdate = undefined
  context.afterWrite = undefined
})

afterEach(() => context.sqlite?.close())

const cases = [
  { id: 'doc', table: 'documents', column: 'content', body: { content: 'My change' }, load: () => import('../../server/api/documents/[id].patch'), responseKey: 'document', valueKey: 'content', staleCode: 'stale_document' },
  { id: 'canvas', table: 'canvases', column: 'title', body: { title: 'My change' }, load: () => import('../../server/api/canvases/[id].patch'), responseKey: 'canvas', valueKey: 'title', staleCode: 'stale_canvas' },
  { id: 'node', table: 'canvas_nodes', column: 'content', body: { content: 'My change' }, load: () => import('../../server/api/canvas-nodes/[id].patch'), responseKey: 'node', valueKey: 'content', staleCode: 'stale_canvas_item' },
  { id: 'item', table: 'database_items', column: 'text_1', body: { values: { field: 'My change' } }, load: () => import('../../server/api/database-items/[id].patch'), responseKey: 'item', valueKey: 'values.field', staleCode: 'stale_record' },
]

describe.each(cases)('$table optimistic concurrency', ({ id, table, column, body, load, responseKey, valueKey, staleCode }) => {
  it('acknowledges exactly its own committed values even when another writer commits before the response', async () => {
    context.id = id
    context.body = { ...body, version: 1 }
    context.afterWrite = () => context.sqlite!.prepare(`UPDATE ${table} SET ${column} = ?, version = version + 1 WHERE id = ?`).run('Other writer', id)
    const { default: handler } = await load()
    const result = await handler({} as Parameters<typeof handler>[0])
    expect(result).toHaveProperty(`${responseKey}.version`, 2)
    expect(result).toHaveProperty(`${responseKey}.${valueKey}`, 'My change')
    expect(context.sqlite!.prepare(`SELECT ${column} as value, version FROM ${table} WHERE id = ?`).get(id)).toEqual({ value: 'Other writer', version: 3 })
    if (responseKey === 'item') expect(result).not.toHaveProperty('item.text_1')
  })

  it('rejects a writer that becomes stale between the initial read and conditional update', async () => {
    context.id = id
    context.body = { ...body, version: 1 }
    context.beforeUpdate = () => context.sqlite!.prepare(`UPDATE ${table} SET ${column} = ?, version = version + 1 WHERE id = ?`).run('Other writer', id)
    const { default: handler } = await load()
    await expect(handler({} as Parameters<typeof handler>[0])).rejects.toMatchObject({ statusCode: 409, code: staleCode })
    expect(context.sqlite!.prepare(`SELECT ${column} as value, version FROM ${table} WHERE id = ?`).get(id)).toEqual({ value: 'Other writer', version: 2 })
  })
})
