CREATE TABLE agent_schedules (
 id TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES users(id), created_by TEXT NOT NULL REFERENCES users(id),
 channel_id TEXT NOT NULL REFERENCES channels(id), kind TEXT NOT NULL CHECK(kind IN ('reminder','work')), content TEXT NOT NULL,
 agent_id TEXT REFERENCES agents(user_id), task_id TEXT REFERENCES tasks(id), first_at TEXT NOT NULL, timezone TEXT NOT NULL,
 recurrence TEXT NOT NULL CHECK(recurrence IN ('once','daily','weekly')), next_at TEXT,
 status TEXT NOT NULL CHECK(status IN ('active','completed','cancelled','blocked')), last_error TEXT,
 authorization_json TEXT NOT NULL, mandate_json TEXT, created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE agent_schedule_occurrences (
 schedule_id TEXT NOT NULL REFERENCES agent_schedules(id), due_at TEXT NOT NULL, message_id TEXT NOT NULL,
 run_id TEXT REFERENCES agent_runs(id), completed_at TEXT, PRIMARY KEY(schedule_id,due_at)
);
