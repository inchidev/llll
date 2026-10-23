CREATE TABLE agent_run_deliveries (
  run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  task_status TEXT NOT NULL DEFAULT 'pending',
  task_error TEXT,
  report_status TEXT NOT NULL DEFAULT 'pending',
  report_error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
