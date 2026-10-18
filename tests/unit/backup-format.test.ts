import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { createTarStream, sqlIdentifier, sqlInsertStatements, sqlValue, textEntry } from '../../server/utils/backup-format'
import { createWorkspaceBackup } from '../../server/utils/workspace-backup'
import { INIT_SQL } from '../../server/utils/db'
import type { L4Env } from '../../workers/env'

async function streamBytes(stream: ReadableStream<Uint8Array>) {
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function ascii(bytes: Uint8Array) {
  return new TextDecoder().decode(bytes).replaceAll('\0', '')
}

function tarFiles(archive: Uint8Array) {
  const files = new Map<string, Uint8Array>()
  let offset = 0
  while (offset + 512 <= archive.byteLength) {
    const header = archive.slice(offset, offset + 512)
    const name = ascii(header.slice(0, 100))
    if (!name) break
    const size = Number.parseInt(ascii(header.slice(124, 136)).trim(), 8)
    const start = offset + 512
    files.set(name, archive.slice(start, start + size))
    offset = start + Math.ceil(size / 512) * 512
  }
  return files
}

describe('backup format', () => {
  it('writes a valid padded ustar archive', async () => {
    async function* entries() {
      yield textEntry('hello.txt', 'hello', new Date('2026-09-05T00:00:00Z'))
    }

    const archive = await streamBytes(createTarStream(entries()))
    expect(archive.byteLength).toBe(2048)
    expect(ascii(archive.slice(0, 100))).toBe('hello.txt')
    expect(ascii(archive.slice(124, 136)).trim()).toBe('00000000005')
    expect(ascii(archive.slice(257, 263))).toBe('ustar')
    expect(ascii(archive.slice(512, 517))).toBe('hello')
    expect(archive.slice(1024).every(byte => byte === 0)).toBe(true)
  })

  it('escapes SQL identifiers and values for a logical D1 export', () => {
    expect(sqlIdentifier('odd"table')).toBe('"odd""table"')
    expect(sqlValue("it's here")).toBe("'it''s here'")
    expect(sqlValue('zero\0byte')).toBe("CAST(X'7a65726f0062797465' AS TEXT)")
    expect(sqlValue(new Uint8Array([0, 15, 255]))).toBe("X'000fff'")
    expect(sqlValue([0, 15, 255])).toBe("X'000fff'")
    expect(sqlValue(null)).toBe('NULL')
    expect(sqlValue(true)).toBe('1')
  })

  it('restores oversized Unicode, NUL, and binary values without oversized statements or partial rows', () => {
    const database = new DatabaseSync(':memory:')
    try {
      database.exec('CREATE TABLE records (id TEXT PRIMARY KEY, first TEXT NOT NULL CHECK(length(first) > 100), second TEXT, binary BLOB)')
      const first = "🙂 owner's ".repeat(20_000)
      const second = '日本語\0'.repeat(20_000)
      const binary = Array.from({ length: 90_000 }, (_, index) => index % 256)
      const statements = sqlInsertStatements('records', ['id', 'first', 'second', 'binary'], { id: 'record', first, second, binary })
      expect(statements.every(sql => new TextEncoder().encode(sql).byteLength < 100_000)).toBe(true)
      database.exec('BEGIN TRANSACTION')
      for (const sql of statements) database.exec(sql)
      database.exec('COMMIT')
      expect(database.prepare('SELECT id, first, second, binary FROM records').get()).toEqual({
        id: 'record', first, second, binary: new Uint8Array(binary),
      })
      expect(database.prepare("SELECT name FROM sqlite_master WHERE name = '__llll_restore_values'").get()).toBeUndefined()
    }
    finally { database.close() }
  })

  it('streams D1 rows and R2 objects into a restorable workspace archive', async () => {
    const database = {
      async batch(statements: Array<{ all: () => Promise<{ results: unknown[] }> }>) {
        return Promise.all(statements.map(statement => statement.all()))
      },
      prepare(sql: string) {
        let params: unknown[] = []
        return {
          bind(...values: unknown[]) {
            params = values
            return this
          },
          async all() {
            if (sql.includes('FROM sqlite_master')) {
              return { results: [
                { type: 'table', name: 'notes', tableName: 'notes', sql: 'CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT)' },
                { type: 'table', name: 'search_data', tableName: 'search_data', sql: 'CREATE TABLE search_data (id INTEGER PRIMARY KEY, block BLOB)' },
                { type: 'index', name: 'notes_body_idx', tableName: 'notes', sql: 'CREATE INDEX notes_body_idx ON notes (body)' },
              ] }
            }
            if (sql === 'PRAGMA table_list') return { results: [{ name: 'notes', type: 'table' }, { name: 'search_data', type: 'shadow' }] }
            if (sql.startsWith('PRAGMA table_info')) return { results: [{ name: 'id' }, { name: 'body' }] }
            if (sql.startsWith('SELECT * FROM')) {
              return Number(params[1]) === 0
                ? { results: [{ id: 'note-1', body: "owner's note" }] }
                : { results: [] }
            }
            throw new Error(`Unexpected query: ${sql}`)
          },
        }
      },
    }
    const objectBytes = new TextEncoder().encode('attachment')
    const env = {
      DB: { withSession: () => database },
      FILES: {
        list: async () => ({
          objects: [{
            key: 'main/attachments/file.txt',
            size: objectBytes.byteLength,
            etag: 'etag-1',
            uploaded: new Date('2026-09-05T00:00:00Z'),
            storageClass: 'Standard',
            httpMetadata: { contentType: 'text/plain' },
            customMetadata: {},
          }],
          truncated: false,
        }),
        get: async () => ({ body: new Blob([objectBytes]).stream() }),
      },
    } as unknown as L4Env

    const archive = await streamBytes(createWorkspaceBackup(env, '2026-09-05T00:00:00.000Z', '0.2.0'))
    const files = tarFiles(archive)
    expect([...files.keys()]).toEqual([
      'README.txt',
      'manifest.json',
      'database/000000-schema.sql',
      'database/000001-000001.sql',
      'database/999999-indexes.sql',
      'r2/00000001.json',
      'r2/00000001.bin',
      'summary.json',
    ])
    expect(ascii(files.get('database/000001-000001.sql')!)).toContain("VALUES ('note-1', 'owner''s note');")
    expect(ascii(files.get('database/000000-schema.sql')!)).not.toContain('search_data')
    expect(ascii(files.get('r2/00000001.json')!)).toContain('main/attachments/file.txt')
    expect(ascii(files.get('r2/00000001.bin')!)).toBe('attachment')
    expect(JSON.parse(ascii(files.get('summary.json')!))).toMatchObject({ databaseRows: 1, r2Objects: 1, r2Bytes: 10 })
  })

  it('restores the installation schema and foreign-key-linked rows in one D1-style transaction', async () => {
    const source = new DatabaseSync(':memory:')
    const restored = new DatabaseSync(':memory:')
    try {
      source.exec(INIT_SQL)
      source.exec(`
        CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB);
        INSERT INTO _cf_KV VALUES ('platform-key', X'0102');
        INSERT INTO roles (id, key, name, permissions_bitmask) VALUES ('owner-role', 'owner', 'Owner', 1023);
        INSERT INTO identity_keys (id, name, email) VALUES ('owner', 'Owner', 'owner@example.com');
        INSERT INTO users (id, display_name, status, role_id, joined_at) VALUES ('owner', 'Owner', 'active', 'owner-role', CURRENT_TIMESTAMP);
        INSERT INTO server_identity(singleton,id) VALUES (1,'00000000-0000-4000-8000-000000000001');
        INSERT INTO workspace (id, name, owner_id) VALUES ('00000000-0000-4000-8000-000000000001','Workspace', 'owner');
        INSERT INTO channels (id, name, type, visibility) VALUES ('channel', 'general', 'text', 'workspace');
        INSERT INTO messages (id, channel_id, author_id, content, created_at) VALUES ('message', 'channel', 'owner', 'A searchable message', CURRENT_TIMESTAMP);
        INSERT INTO channels (id, name, type, visibility, parent_id, parent_message_id)
          VALUES ('thread', 'Thread', 'thread', 'workspace', 'channel', 'message');
        INSERT INTO messages (id, channel_id, author_id, content, created_at) VALUES ('reply', 'thread', 'owner', 'Reply', CURRENT_TIMESTAMP);
        INSERT INTO documents (id, title, content, created_by) VALUES ('doc', 'Plan', '<p>Hello</p>', 'owner');
        INSERT INTO canvases (id, title, created_by) VALUES ('canvas', 'Launch', 'owner');
        INSERT INTO canvas_nodes (id, canvas_id, content, created_by) VALUES ('node', 'canvas', 'Start', 'owner');
      `)
      const richDocument = '<p>日本語🙂 long document</p>'.repeat(6000)
      source.prepare('UPDATE documents SET content = ? WHERE id = ?').run(richDocument, 'doc')
      const database = {
        async batch(statements: Array<{ all: () => Promise<{ results: unknown[] }> }>) {
          return Promise.all(statements.map(statement => statement.all()))
        },
        prepare(sql: string) {
          let params: SQLInputValue[] = []
          return {
            bind(...values: SQLInputValue[]) { params = values; return this },
            async all() { return { results: source.prepare(sql).all(...params) } },
          }
        },
      }
      const env = {
        DB: { withSession: () => database },
        FILES: { list: async () => ({ objects: [], truncated: false }) },
      } as unknown as L4Env
      const files = tarFiles(await streamBytes(createWorkspaceBackup(env, '2026-09-05T00:00:00.000Z', '0.2.0')))
      const sql = [...files.entries()]
        .filter(([name]) => name.startsWith('database/'))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, bytes]) => ascii(bytes)).join('\n')
      expect(sql).not.toMatch(/BEGIN TRANSACTION|COMMIT;|PRAGMA foreign_keys=/u)
      expect(sql).not.toContain('_cf_KV')
      // D1 owns the transaction and always enforces foreign keys; its importer
      // must receive the complete archive SQL together, including cyclic links.
      restored.exec('PRAGMA foreign_keys=ON; BEGIN TRANSACTION;')
      restored.exec(sql)
      restored.exec('COMMIT;')
      expect(restored.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect(restored.prepare('SELECT parent_message_id FROM channels WHERE id = ?').get('thread')).toEqual({ parent_message_id: 'message' })
      expect(restored.prepare('SELECT channel_id FROM messages WHERE id = ?').get('reply')).toEqual({ channel_id: 'thread' })
      expect(restored.prepare('SELECT content FROM documents WHERE id = ?').get('doc')).toEqual({ content: richDocument })
      expect(restored.prepare("SELECT message_id FROM message_search WHERE message_search MATCH 'searchable'").all()).toEqual([{ message_id: 'message' }])
      restored.exec("UPDATE messages SET content = 'Changed' WHERE id = 'message'")
      expect(restored.prepare("SELECT message_id FROM message_search WHERE message_search MATCH 'Changed'").all()).toEqual([{ message_id: 'message' }])
    }
    finally {
      source.close()
      restored.close()
    }
  })

})
