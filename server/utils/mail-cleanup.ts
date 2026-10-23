import { fileStorage } from '../../shared/file-storage'
import type { L4Env } from '../../workers/env'

/** Record keys and remove the mailbox in one transaction, before any blob work. */
export async function removeMailboxData(env: L4Env, mailboxId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO mail_file_deletions (key, mailbox_id, created_at)
       WITH RECURSIVE conversations(id) AS (
         SELECT ? UNION ALL SELECT c.id FROM channels c JOIN conversations p ON c.parent_id = p.id
       )
       SELECT key, ?, ? FROM (
         SELECT raw_r2_key as key FROM email_messages WHERE mailbox_channel_id = ? AND raw_r2_key IS NOT NULL
         UNION SELECT r2_key as key FROM attachments WHERE channel_id IN (SELECT id FROM conversations)
       )`,
    ).bind(mailboxId, mailboxId, new Date().toISOString(), mailboxId),
    env.DB.prepare('DELETE FROM channels WHERE id = ?').bind(mailboxId),
  ])
}

/** One bounded, idempotent batch. A failure retains every key for a later retry. */
export async function cleanMailFiles(env: L4Env, mailboxId?: string): Promise<number> {
  const query = env.DB.prepare(`SELECT key FROM mail_file_deletions ${mailboxId ? 'WHERE mailbox_id = ?' : ''} ORDER BY created_at, key LIMIT 100`)
  const rows = await (mailboxId ? query.bind(mailboxId) : query).all<{ key: string }>()
  const keys = (rows.results ?? []).map(row => row.key)
  if (!keys.length) return 0
  await fileStorage(env).delete(keys)
  await env.DB.prepare(`DELETE FROM mail_file_deletions WHERE key IN (${keys.map(() => '?').join(',')})`).bind(...keys).run()
  return keys.length
}

/** Mail polling and settings visits retry cleanup left by interrupted deletions. */
export async function retryMailFileCleanup(env: L4Env): Promise<void> {
  try { await cleanMailFiles(env) }
  catch { console.warn('Mail file cleanup is pending; the next Mail refresh will retry it') }
}
