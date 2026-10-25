ALTER TABLE agent_sessions ADD COLUMN untrusted_at TEXT;
--> statement-breakpoint
UPDATE agent_sessions SET untrusted_at=updated_at WHERE transcript_key IS NOT NULL OR EXISTS(SELECT 1 FROM agent_runs r WHERE r.session_id=agent_sessions.id AND (r.task_id IS NOT NULL OR EXISTS(SELECT 1 FROM agent_run_tools t WHERE t.run_id=r.id AND t.name NOT IN ('get_current_time','search_tools','get_tool_details'))));
--> statement-breakpoint
CREATE TABLE agent_tool_decisions (
 run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
 call_id TEXT NOT NULL,
 tool TEXT NOT NULL,
 effect TEXT NOT NULL CHECK(effect IN ('control','read','write','external','unknown')),
 untrusted_context INTEGER NOT NULL CHECK(untrusted_context IN (0,1)),
 decision TEXT NOT NULL CHECK(decision IN ('allowed','blocked')),
 reason TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(run_id,call_id)
);
