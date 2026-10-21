CREATE TABLE agent_environments (
 id TEXT PRIMARY KEY, config_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1,
 created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN environment_id TEXT REFERENCES agent_environments(id);
--> statement-breakpoint
ALTER TABLE agent_runs ADD COLUMN environment_json TEXT;
--> statement-breakpoint
CREATE TABLE agent_code_proposals (
 run_id TEXT PRIMARY KEY REFERENCES agent_runs(id), environment_id TEXT NOT NULL REFERENCES agent_environments(id),
 input_hash TEXT NOT NULL, branch TEXT NOT NULL, commit_sha TEXT, pull_number INTEGER,
 lease_until TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
