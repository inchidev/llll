import type { L4Env } from '../../workers/env'

/** Record keys and remove the mailbox in one transaction, before any blob work. */
export async function removeMailboxData(env: L4Env, mailboxId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO file_deletions (key, scope_id, created_at)
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

export { cleanDeletedFiles as cleanMailFiles, retryDeletedFiles as retryMailFileCleanup } from '../../shared/file-cleanup'
