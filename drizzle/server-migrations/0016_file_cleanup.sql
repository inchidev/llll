CREATE TABLE file_deletions (key TEXT PRIMARY KEY NOT NULL, scope_id TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX file_deletions_scope_idx ON file_deletions(scope_id);
-- Revoke attachments left by soft deletions before this migration.
INSERT OR IGNORE INTO file_deletions (key, scope_id, created_at)
  SELECT a.r2_key, a.channel_id, m.deleted_at FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.deleted_at IS NOT NULL;
DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE deleted_at IS NOT NULL);
