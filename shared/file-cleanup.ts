import { fileStorage } from './file-storage'
import type { L4Env } from '../workers/env'

/** Queue blob keys in the same transaction that revokes access to a message. */
export async function removeMessageData(env: L4Env, id: string, deletedAt: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO file_deletions (key, scope_id, created_at)
      SELECT r2_key, channel_id, ? FROM attachments WHERE message_id = ?`).bind(deletedAt, id),
    env.DB.prepare('UPDATE messages SET deleted_at = ?, content = ? WHERE id = ?').bind(deletedAt, '', id),
    env.DB.prepare('DELETE FROM attachments WHERE message_id = ?').bind(id),
    env.DB.prepare('DELETE FROM message_pins WHERE message_id = ?').bind(id),
  ])
}

/** Bounded and idempotent; failed storage deletion keeps the keys for a later retry. */
export async function cleanDeletedFiles(env: L4Env, scopeId?: string): Promise<number> {
  const query = env.DB.prepare(`SELECT key FROM file_deletions ${scopeId ? 'WHERE scope_id = ?' : ''} ORDER BY created_at, key LIMIT 100`)
  const rows = await (scopeId ? query.bind(scopeId) : query).all<{ key: string }>()
  const keys = (rows.results ?? []).map(row => row.key)
  if (!keys.length) return 0
  await fileStorage(env).delete(keys)
  await env.DB.prepare(`DELETE FROM file_deletions WHERE key IN (${keys.map(() => '?').join(',')})`).bind(...keys).run()
  return keys.length
}

export async function retryDeletedFiles(env: L4Env): Promise<void> {
  try { await cleanDeletedFiles(env) }
  catch { console.warn('File cleanup is pending; a later refresh will retry it') }
}
