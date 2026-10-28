-- A paused mandate keeps status 'active' and its due time, so it still counts toward the active limit.
ALTER TABLE agent_schedules ADD COLUMN paused_at TEXT;
--> statement-breakpoint
-- Hides a finished schedule from its owner's list; the inert row stays for occurrence history.
ALTER TABLE agent_schedules ADD COLUMN dismissed_at TEXT;
--> statement-breakpoint
ALTER TABLE agent_schedules ADD COLUMN last_error_code TEXT;
--> statement-breakpoint
ALTER TABLE agent_schedule_occurrences ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE agent_schedule_occurrences ADD COLUMN failed_at TEXT;
--> statement-breakpoint
ALTER TABLE agent_schedule_occurrences ADD COLUMN last_error TEXT;
--> statement-breakpoint
CREATE INDEX agent_schedules_created_by_status_idx ON agent_schedules(created_by,status,next_at);
--> statement-breakpoint
CREATE INDEX agent_schedules_principal_status_idx ON agent_schedules(principal_id,status,next_at);
