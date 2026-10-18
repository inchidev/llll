import type { D1Database } from '@cloudflare/workers-types'
const serverIds = new WeakMap<D1Database, string>()

/** Permanent UUIDv4 of this independently deployed Server, including before owner setup. */
export async function getServerId(db: D1Database): Promise<string> {
  const cached = serverIds.get(db)
  if (cached) return cached
  const existing = await db
    .prepare('SELECT id FROM server_identity WHERE singleton = 1')
    .first<{ id: string }>()
  if (existing) {
    serverIds.set(db, existing.id)
    return existing.id
  }
  await db
    .prepare(
      'INSERT INTO server_identity(singleton,id) VALUES (1,?) ON CONFLICT(singleton) DO NOTHING',
    )
    .bind(crypto.randomUUID())
    .run()
  const row = await db
    .prepare('SELECT id FROM server_identity WHERE singleton = 1')
    .first<{ id: string }>()
  if (!row) throw new Error('Server identity is unavailable')
  serverIds.set(db, row.id)
  return row.id
}
