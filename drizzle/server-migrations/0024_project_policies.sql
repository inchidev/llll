CREATE TABLE project_policies (
 id TEXT PRIMARY KEY,
 name TEXT NOT NULL UNIQUE,
 description TEXT NOT NULL DEFAULT '',
 permissions_bitmask INTEGER NOT NULL CHECK(permissions_bitmask >= 0),
 version INTEGER NOT NULL DEFAULT 1,
 created_by TEXT REFERENCES users(id),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE TABLE project_policy_assignments (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 policy_id TEXT NOT NULL REFERENCES project_policies(id) ON DELETE CASCADE,
 member_id TEXT REFERENCES users(id) ON DELETE CASCADE,
 role_id TEXT REFERENCES roles(id) ON DELETE CASCADE,
 created_by TEXT NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL,
 CHECK((member_id IS NOT NULL AND role_id IS NULL) OR (role_id IS NOT NULL AND member_id IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX project_policy_members ON project_policy_assignments(project_id,policy_id,member_id) WHERE member_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX project_policy_roles ON project_policy_assignments(project_id,policy_id,role_id) WHERE role_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX project_policy_assignments_member ON project_policy_assignments(member_id,project_id);
--> statement-breakpoint
CREATE INDEX project_policy_assignments_role ON project_policy_assignments(role_id,project_id);
--> statement-breakpoint
INSERT INTO project_policies(id,name,description,permissions_bitmask) VALUES
 ('project-policy-developer','Developer','Work on assigned project tasks and propose code changes.',94085120),
 ('project-policy-reviewer','Reviewer','Read project tasks and inspect code in an isolated workspace. Does not grant code publication or task editing.',76259328),
 ('project-policy-coordinator','Coordinator','Read and organize project tasks and invoke agents. Does not grant computer access or code publication.',68689920);
