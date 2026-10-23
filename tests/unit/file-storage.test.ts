import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1 } from '../helpers/sqlite-d1'
import { INIT_SQL } from '../../server/utils/db'
import { BASIC_FILE_LIMIT, BASIC_STORAGE_LIMIT, fileStorage } from '../../shared/file-storage'

const state = vi.hoisted(() => ({ env: {} as { DB: D1Database; TICKETS: KVNamespace; FILES?: R2Bucket } }))
vi.mock('../../server/utils/server-updates', () => ({ updateOwner: async () => ({ env: state.env }) }))
let db: DatabaseSync
let objects: Map<string, ArrayBuffer>
let put: ReturnType<typeof vi.fn>
beforeEach(() => {
  db = new DatabaseSync(':memory:'); db.exec(INIT_SQL)
  objects = new Map()
  put = vi.fn(async (key: string, bytes: Uint8Array) => { objects.set(key, new Uint8Array(bytes).buffer) })
  state.env = { DB: d1(db), TICKETS: { put, get: async (key: string) => objects.get(key) ?? null, delete: async (key: string) => { objects.delete(key) } } as unknown as KVNamespace }
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
})
afterEach(() => { db.close(); vi.unstubAllGlobals() })
describe('basic files in the existing tickets namespace', () => {
  it('keeps an indexed immutable object and serves the requested range with metadata', async () => {
    const files = fileStorage(state.env)
    await files.put('attachment/a', 'hello world', { httpMetadata: { contentType: 'text/plain' } })
    const entry = db.prepare('SELECT storage_key,size FROM file_objects').get()!
    expect(entry.storage_key).toMatch(/^files\//u)
    expect(entry.size).toBe(11)
    expect(await (await files.get('attachment/a', { range: { offset: 6, length: 5 } }))?.text()).toBe('world')
    expect((await files.head('attachment/a'))?.httpMetadata?.contentType).toBe('text/plain')
    expect((await files.list({ prefix: 'attachment/' })).objects).toHaveLength(1)
    await files.delete('attachment/a')
    expect(await files.get('attachment/a')).toBeNull()
    expect(objects.size).toBe(0)
  })
  it('does not lose a previous version when KV rejects a replacement', async () => {
    const files = fileStorage(state.env)
    await files.put('a', 'original')
    put.mockRejectedValueOnce(new Error('Daily quota exhausted'))
    await expect(files.put('a', 'replacement')).rejects.toMatchObject({ statusCode: 503 })
    expect(await (await files.get('a'))?.text()).toBe('original')
    expect(db.prepare('SELECT count(*) AS n FROM file_uploads').get()?.n).toBe(0)
  })
  it('bounds each object and reserves the total quota before writing KV', async () => {
    const files = fileStorage(state.env)
    await expect(files.put('huge', new Uint8Array(BASIC_FILE_LIMIT + 1))).rejects.toMatchObject({ statusCode: 413 })
    db.prepare('INSERT INTO file_objects VALUES(?,?,?,?,?,?,0)').run('existing', 'files/existing', BASIC_STORAGE_LIMIT - 4, 'hash', new Date().toISOString(), '{}')
    const results = await Promise.allSettled([files.put('first', 'four'), files.put('second', 'four')])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { statusCode: 507 } })
    expect(put).toHaveBeenCalledTimes(1)
  })
  it('reports delayed KV propagation rather than claiming an indexed file is missing', async () => {
    const files = fileStorage(state.env)
    await files.put('a', 'data'); objects.clear()
    await expect(files.get('a')).rejects.toMatchObject({ statusCode: 503, data: { error: { code: 'file_propagating' } } })
  })
  it('copies to R2 explicitly, verifies every copy, preserves KV and serves subsequent R2 replacements', async () => {
    const files = fileStorage(state.env)
    db.prepare('INSERT INTO server_settings(key,value,updated_at) VALUES(?,?,?)').run('storage.backend', 'kv', new Date().toISOString())
    await files.put('a', 'original')
    const original = [...objects.values()][0]
    const r2 = new Map<string, ArrayBuffer>()
    state.env.FILES = {
      put: async (key: string, value: ArrayBuffer | string) => { r2.set(key, typeof value === 'string' ? new TextEncoder().encode(value).buffer : value) },
      get: async (key: string) => { const bytes = r2.get(key); return bytes ? { size: bytes.byteLength, arrayBuffer: async () => bytes, text: async () => new TextDecoder().decode(bytes) } : null },
      head: async (key: string) => ({ size: r2.get(key)?.byteLength }),
    } as unknown as R2Bucket
    expect(await (await fileStorage(state.env).get('a'))?.text()).toBe('original')
    const migrate = (await import('../../server/api/servers/[id]/storage/migrate.post')).default
    expect(await migrate({} as never)).toMatchObject({ done: true })
    expect([...objects.values()][0]).toEqual(original)
    await fileStorage(state.env).put('a', 'R2 replacement')
    expect(await (await fileStorage(state.env).get('a'))?.text()).toBe('R2 replacement')
    expect((await fileStorage(state.env).head('a'))?.size).toBe(14)
  })
  it('keeps using the source and can resume after a corrupt R2 copy', async () => {
    const files = fileStorage(state.env)
    db.prepare('INSERT INTO server_settings(key,value,updated_at) VALUES(?,?,?)').run('storage.backend', 'kv', new Date().toISOString())
    await files.put('a', 'original')
    state.env.FILES = { put: async () => {}, get: async () => ({ size: 3, arrayBuffer: async () => new TextEncoder().encode('bad').buffer }) } as unknown as R2Bucket
    const migrate = (await import('../../server/api/servers/[id]/storage/migrate.post')).default
    await expect(migrate({} as never)).rejects.toMatchObject({ statusCode: 502 })
    expect(db.prepare("SELECT value FROM server_settings WHERE key='storage.backend'").get()?.value).toBe('kv')
    expect(await (await fileStorage(state.env).get('a'))?.text()).toBe('original')
    await expect(fileStorage(state.env).put('b', 'blocked')).rejects.toMatchObject({ statusCode: 409 })
  })
})
