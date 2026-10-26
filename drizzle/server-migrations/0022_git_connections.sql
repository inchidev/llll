CREATE TABLE git_connections (
 id TEXT PRIMARY KEY,
 name TEXT NOT NULL,
 provider TEXT NOT NULL,
 host TEXT NOT NULL,
 account TEXT NOT NULL,
 app_id TEXT NOT NULL,
 app_slug TEXT NOT NULL,
 credential_json TEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 1,
 created_by TEXT NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE git_setup_requests (
 state_hash TEXT PRIMARY KEY,
 name TEXT NOT NULL,
 account TEXT NOT NULL,
 actor_id TEXT NOT NULL REFERENCES users(id),
 origin TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','exchanging','complete','failed')),
 created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL
);
