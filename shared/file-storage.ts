/// <reference types="@cloudflare/workers-types" />
import { createError } from 'h3'

export const BASIC_FILE_LIMIT = 20 * 1024 * 1024
export const BASIC_STORAGE_LIMIT = 500 * 1024 * 1024
export type FileBody = Pick<R2ObjectBody, 'key' | 'size' | 'etag' | 'httpEtag' | 'uploaded' | 'httpMetadata' | 'customMetadata' | 'body' | 'text' | 'arrayBuffer'>
type FileInfo = Pick<R2Object, 'key' | 'size' | 'etag' | 'httpEtag' | 'uploaded' | 'httpMetadata' | 'customMetadata'>
type FileInput = string | ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>
type FileOptions = { httpMetadata?: R2HTTPMetadata; customMetadata?: Record<string, string> }
type ReadOptions = { range?: { offset: number; length?: number }; onlyIf?: { etagMatches: string } }
export type FileStore = {
  put(key: string, value: FileInput, options?: FileOptions): Promise<unknown>
  get(key: string, options?: ReadOptions): Promise<FileBody | null>
  head(key: string): Promise<FileInfo | null>
  delete(key: string | string[]): Promise<void>
  list(options?: { limit?: number; cursor?: string; prefix?: string; include?: ('httpMetadata' | 'customMetadata')[] }): Promise<{ objects: FileInfo[]; truncated: boolean; cursor?: string }>
}
export type FileStorageEnv = { DB?: D1Database; TICKETS?: KVNamespace; FILES?: R2Bucket }
type StoredFile = { key: string; storage_key: string; size: number; etag: string; uploaded_at: string; metadata: string; copied: number }
const unavailable = (code: string, message: string, statusCode = 409) => createError({ statusCode, statusMessage: message, data: { error: { code, message } } })
const info = (row: StoredFile): FileInfo => ({ key: row.key, size: row.size, etag: row.etag, httpEtag: `"${row.etag}"`, uploaded: new Date(row.uploaded_at), ...JSON.parse(row.metadata) })

async function bytesOf(value: FileInput): Promise<Uint8Array> {
  if (typeof value === 'string') return new TextEncoder().encode(value)
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (value instanceof Uint8Array) return value
  const reader = value.getReader(), parts: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > BASIC_FILE_LIMIT) { await reader.cancel(); throw unavailable('file_too_large', 'Basic storage accepts files up to 20 MiB.', 413) }
      parts.push(next.value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength }
  return bytes
}

/** Immutable KV objects; D1 owns the index, access-independent metadata and atomic quota reservations. */
export function fileStorage(env: FileStorageEnv): FileStore {
  const db = env.DB, kv = env.TICKETS, r2 = env.FILES
  if (!r2 && (!db || !kv)) throw unavailable('files_disabled', 'File storage is unavailable. Ask the Server operator to configure storage.')
  if (!db || !kv) return r2!
  const row = (key: string) => db.prepare('SELECT * FROM file_objects WHERE key=?').bind(key).first<StoredFile>()
  const basic = async () => !r2 || (await db.prepare("SELECT value FROM server_settings WHERE key='storage.backend'").first<{ value: string }>())?.value === 'kv'
  return {
    async put(key, value, options = {}) {
      if ((await db.prepare("SELECT value FROM server_settings WHERE key='storage.migration'").first<{ value: string }>())?.value === 'r2') throw unavailable('storage_migrating', 'File migration is in progress. Retry the upload after it completes.')
      if (!r2) await db.prepare("INSERT INTO server_settings(key,value,updated_at) VALUES('storage.backend','kv',?) ON CONFLICT(key) DO UPDATE SET value='kv',updated_at=excluded.updated_at").bind(new Date().toISOString()).run()
      if (!await basic()) return r2!.put(key, value, options)
      const bytes = await bytesOf(value)
      if (bytes.byteLength > BASIC_FILE_LIMIT) throw unavailable('file_too_large', 'Basic storage accepts files up to 20 MiB.', 413)
      const abandoned = (await db.prepare('DELETE FROM file_uploads WHERE created_at<? RETURNING id').bind(new Date(Date.now() - 15 * 60_000).toISOString()).all<{ id: string }>()).results
      for (const item of abandoned) await kv.delete(`files/${item.id}`).catch(() => {})
      const id = crypto.randomUUID(), storageKey = `files/${id}`
      const reserved = await db.prepare(`INSERT INTO file_uploads(id,key,size,created_at)
        SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM server_settings WHERE key='storage.migration' AND value='r2') AND (SELECT COALESCE(SUM(size),0) FROM file_objects)-COALESCE((SELECT size FROM file_objects WHERE key=?),0)+(SELECT COALESCE(SUM(size),0) FROM file_uploads)+?<=? RETURNING id`)
        .bind(id, key, bytes.byteLength, new Date().toISOString(), key, bytes.byteLength, BASIC_STORAGE_LIMIT).first()
        .catch(() => { throw unavailable('upload_busy', 'Another upload is changing this file. Retry shortly.') })
      if (!reserved) throw unavailable('storage_full', 'Basic storage is full (500 MiB). Delete files or connect R2.', 507)
      const previous = await row(key)
      const etag = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer))).map(b => b.toString(16).padStart(2, '0')).join('')
      try {
        await kv.put(storageKey, bytes)
        const committed = await db.batch([
          db.prepare(`INSERT INTO file_objects(key,storage_key,size,etag,uploaded_at,metadata) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM file_uploads WHERE id=?)
            ON CONFLICT(key) DO UPDATE SET storage_key=excluded.storage_key,size=excluded.size,etag=excluded.etag,uploaded_at=excluded.uploaded_at,metadata=excluded.metadata,copied=0`)
            .bind(key, storageKey, bytes.byteLength, etag, new Date().toISOString(), JSON.stringify(options), id),
          db.prepare('DELETE FROM file_uploads WHERE id=?').bind(id),
        ])
        if (!committed[0]?.meta.changes) throw new Error('Upload reservation expired')
      } catch {
        await db.prepare('DELETE FROM file_uploads WHERE id=?').bind(id).run()
        await kv.delete(storageKey).catch(() => {})
        throw unavailable('storage_write_failed', 'Could not save the file. The storage quota may be exhausted; retry later.', 503)
      }
      if (previous) await kv.delete(previous.storage_key).catch(() => {})
    },
    async get(key, options) {
      const stored = await row(key)
      if (!stored || (stored.copied && !await basic())) return r2 ? r2.get(key, options) : null
      if (options?.onlyIf && options.onlyIf.etagMatches !== stored.etag) return null
      const bytes = await kv.get(stored.storage_key, 'arrayBuffer')
      if (!bytes) throw unavailable('file_propagating', 'This file is still becoming available. Retry shortly.', 503)
      const range = options?.range
      const body = range ? bytes.slice(range.offset, range.length === undefined ? undefined : range.offset + range.length) : bytes
      return { ...info(stored), body: new Blob([body]).stream(), text: async () => new TextDecoder().decode(body), arrayBuffer: async () => body }
    },
    async head(key) { const stored = await row(key); return stored && !(stored.copied && !await basic()) ? info(stored) : r2 ? r2.head(key) : null },
    async delete(keys) {
      if ((await db.prepare("SELECT value FROM server_settings WHERE key='storage.migration'").first<{ value: string }>())?.value === 'r2') throw unavailable('storage_migrating', 'File migration is in progress. Retry after it completes.')
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        const stored = await row(key)
        if (stored) { await kv.delete(stored.storage_key); await db.prepare('DELETE FROM file_objects WHERE key=? AND storage_key=?').bind(key, stored.storage_key).run() }
        if (r2) await r2.delete(key)
      }
    },
    async list(options = {}) {
      if (!await basic()) return r2!.list(options)
      const limit = Math.max(1, Math.min(options.limit ?? 1000, 1000))
      const rows = (await db.prepare('SELECT * FROM file_objects WHERE key>? AND substr(key,1,?)=? ORDER BY key LIMIT ?')
        .bind(options.cursor ?? '', (options.prefix ?? '').length, options.prefix ?? '', limit + 1).all<StoredFile>()).results
      return { objects: rows.slice(0, limit).map(info), truncated: rows.length > limit, cursor: rows.length > limit ? rows[limit - 1]!.key : undefined }
    },
  }
}
