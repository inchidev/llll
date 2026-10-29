import type { D1Database } from '@cloudflare/workers-types'
import { isUuidV4 } from './server-settings'
import { bindingIdentity } from './binding-identity'
const serverIds = new WeakMap<D1Database, string>()

/** Permanent UUIDv4 of this independently deployed Server, including before owner setup. */
export async function getServerId(db: D1Database, configured?: string): Promise<string> {
  const cached = serverIds.get(bindingIdentity(db))
  if (cached) return cached
  const existing = await db
    .prepare('SELECT id FROM server_identity WHERE singleton = 1')
    .first<{ id: string }>()
  if (existing) {
    serverIds.set(bindingIdentity(db), existing.id)
    return existing.id
  }
  const id = isUuidV4(configured) ? configured.toLowerCase() : crypto.randomUUID()
  await db
    .prepare(
      'INSERT INTO server_identity(singleton,id) VALUES (1,?) ON CONFLICT(singleton) DO NOTHING',
    )
    .bind(id)
    .run()
  const row = await db
    .prepare('SELECT id FROM server_identity WHERE singleton = 1')
    .first<{ id: string }>()
  if (!row) throw new Error('Server identity is unavailable')
  serverIds.set(bindingIdentity(db), row.id)
  return row.id
}
