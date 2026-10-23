CREATE TABLE mail_file_deletions (key TEXT PRIMARY KEY NOT NULL, mailbox_id TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX mail_file_deletions_mailbox_idx ON mail_file_deletions(mailbox_id);
