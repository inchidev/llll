CREATE TABLE deployment_sessions (id_hash TEXT PRIMARY KEY, payload TEXT NOT NULL, expires_at INTEGER NOT NULL, lease_until INTEGER NOT NULL DEFAULT 0);
CREATE TABLE server_directory (id TEXT PRIMARY KEY, origin TEXT NOT NULL, verified_at INTEGER NOT NULL);
CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
