ALTER TABLE email_messages ADD COLUMN provider_message_id TEXT;
ALTER TABLE email_messages ADD COLUMN delivery_started_at TEXT;
ALTER TABLE email_messages ADD COLUMN reply_to_json TEXT NOT NULL DEFAULT '[]';
-- Earlier REST sends stored a recipient address as a message identifier.
UPDATE email_messages SET provider_message_id = rfc_message_id, rfc_message_id = NULL WHERE direction = 'outbound' AND rfc_message_id LIKE 'cloudflare:%';
