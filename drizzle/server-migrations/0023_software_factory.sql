CREATE TABLE compute_nodes (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
 capabilities_json TEXT NOT NULL DEFAULT '{}', last_seen TEXT, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE compute_pairings (
 token_hash TEXT PRIMARY KEY, name TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE factory_workspaces (
 id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES channels(id), task_id TEXT NOT NULL REFERENCES tasks(id), agent_id TEXT NOT NULL REFERENCES agents(user_id),
 initiated_by TEXT NOT NULL REFERENCES users(id), node_id TEXT NOT NULL REFERENCES compute_nodes(id),
 environment_json TEXT NOT NULL, origin_run_id TEXT NOT NULL REFERENCES agent_runs(id),
 status TEXT NOT NULL DEFAULT 'new', snapshot_json TEXT, pull_json TEXT, commands INTEGER NOT NULL DEFAULT 0,
 runtime_ms INTEGER NOT NULL DEFAULT 0, publication_count INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(task_id,agent_id,initiated_by)
);
--> statement-breakpoint
CREATE TABLE factory_actions (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES factory_workspaces(id), run_id TEXT NOT NULL REFERENCES agent_runs(id),
 call_id TEXT NOT NULL, digest TEXT NOT NULL, request_json TEXT NOT NULL, policy_json TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','approved','claimed','executing','completed','rejected','expired','cancelled','uncertain','failed')),
 expires_at TEXT NOT NULL, created_at TEXT NOT NULL, decided_by TEXT REFERENCES users(id), decided_at TEXT,
 lease_token TEXT, lease_until TEXT, result_json TEXT, completed_at TEXT, UNIQUE(run_id,call_id)
);
--> statement-breakpoint
CREATE INDEX factory_actions_node_queue ON factory_actions(status,created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX factory_one_active_action ON factory_actions(workspace_id) WHERE status IN ('pending','approved','claimed','executing','uncertain');

--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN factory_state TEXT;
