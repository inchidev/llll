CREATE TABLE telegram_links (code TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, server_id TEXT NOT NULL, server_name TEXT NOT NULL, token TEXT, expires_at INTEGER NOT NULL);
