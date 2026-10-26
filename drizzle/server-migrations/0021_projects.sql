CREATE TABLE projects (
 id TEXT PRIMARY KEY,
 name TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 archived_at TEXT,
 version INTEGER NOT NULL DEFAULT 1,
 created_by TEXT NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE project_repositories (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 provider TEXT NOT NULL,
 host TEXT NOT NULL,
 external_id TEXT NOT NULL,
 slug TEXT NOT NULL,
 default_branch TEXT NOT NULL,
 environment_id TEXT UNIQUE REFERENCES agent_environments(id),
 created_by TEXT NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL,
 UNIQUE(project_id,provider,host,external_id)
);
--> statement-breakpoint
CREATE INDEX project_repositories_project ON project_repositories(project_id);
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN project_id TEXT REFERENCES projects(id);
--> statement-breakpoint
CREATE INDEX tasks_project ON tasks(project_id);
