-- Pi is an execution provider. Server-owned facts survive disposable compute.
ALTER TABLE agents ADD COLUMN harness TEXT NOT NULL DEFAULT 'think' CHECK(harness IN ('think','pi'));
--> statement-breakpoint
CREATE TABLE agent_sessions (
 id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(user_id), channel_id TEXT NOT NULL REFERENCES channels(id),
 active_run_id TEXT, transcript_key TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(agent_id,channel_id)
);
--> statement-breakpoint
CREATE TABLE agent_runs (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES agent_sessions(id), agent_id TEXT NOT NULL REFERENCES agents(user_id),
 channel_id TEXT NOT NULL REFERENCES channels(id), initiated_by TEXT NOT NULL REFERENCES users(id), task_id TEXT REFERENCES tasks(id),
 source_message_id TEXT REFERENCES messages(id), idempotency_key TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')),
 prompt TEXT NOT NULL, model TEXT NOT NULL, instructions TEXT NOT NULL, mandate_json TEXT NOT NULL,
 result_text TEXT, result_message_id TEXT, last_error TEXT, model_calls INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0,
 event_cursor INTEGER NOT NULL DEFAULT 0, deadline TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(agent_id,initiated_by,idempotency_key)
);
--> statement-breakpoint
CREATE INDEX agent_runs_session_status ON agent_runs(session_id,status,created_at);
--> statement-breakpoint
CREATE TABLE agent_run_events (
 run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE, sequence INTEGER NOT NULL,
 event_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(run_id,sequence)
);
--> statement-breakpoint
CREATE TABLE agent_run_tools (
 run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE, call_id TEXT NOT NULL, name TEXT NOT NULL,
 arguments_json TEXT NOT NULL, policy_json TEXT NOT NULL DEFAULT '', status TEXT NOT NULL CHECK(status IN ('pending','completed','failed')),
 result_json TEXT, created_at TEXT NOT NULL, PRIMARY KEY(run_id,call_id)
);
