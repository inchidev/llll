CREATE TABLE agent_run_publications (
 id TEXT PRIMARY KEY,
 run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
 digest TEXT NOT NULL,
 payload_json TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','rejected','expired','executing','completed','uncertain')),
 message_id TEXT NOT NULL UNIQUE,
 created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 decided_at TEXT,
 decided_by TEXT REFERENCES users(id),
 completed_at TEXT
);
--> statement-breakpoint
CREATE UNIQUE INDEX agent_run_publication_active ON agent_run_publications(run_id) WHERE status IN ('pending','executing','completed','uncertain');
--> statement-breakpoint
CREATE INDEX agent_run_publication_history ON agent_run_publications(run_id,created_at);
