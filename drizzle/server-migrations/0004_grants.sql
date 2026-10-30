-- One table for scoped access. A grant gives one Member or one Role a Policy on a resource.
-- With agent_id set it is Agent access: the subject may use that Agent with the Policy's
-- permissions even beyond the subject's own Role. Project assignments move here unchanged.
CREATE TABLE grants (
  id TEXT PRIMARY KEY NOT NULL,
  member_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  role_id TEXT REFERENCES roles(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(user_id) ON DELETE CASCADE,
  policy_id TEXT NOT NULL REFERENCES project_policies(id) ON DELETE CASCADE,
  -- NULL means the whole Server. Only Agent access may be Server-wide: a direct
  -- Server-wide grant is a Role.
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  daily_runs INTEGER CHECK(daily_runs IS NULL OR daily_runs BETWEEN 1 AND 10000),
  expires_at TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  CHECK((member_id IS NOT NULL AND role_id IS NULL) OR (role_id IS NOT NULL AND member_id IS NULL)),
  CHECK(agent_id IS NOT NULL OR project_id IS NOT NULL),
  CHECK(agent_id IS NOT NULL OR (daily_runs IS NULL AND expires_at IS NULL))
);
--> statement-breakpoint
INSERT INTO grants(id,member_id,role_id,agent_id,policy_id,project_id,created_by,created_at)
  SELECT id,member_id,role_id,NULL,policy_id,project_id,created_by,created_at FROM project_policy_assignments;
--> statement-breakpoint
DROP TABLE project_policy_assignments;
--> statement-breakpoint
-- An update applies migrations before the new code is uploaded, so the previous release
-- briefly runs on this schema. This view keeps its project-access reads working; its
-- writes fail until the new code is active. A later migration removes the view.
CREATE VIEW project_policy_assignments AS
  SELECT id,project_id,policy_id,member_id,role_id,created_by,created_at FROM grants WHERE agent_id IS NULL AND project_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX grants_member_identity ON grants(member_id,coalesce(agent_id,''),coalesce(project_id,''),policy_id) WHERE member_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX grants_role_identity ON grants(role_id,coalesce(agent_id,''),coalesce(project_id,''),policy_id) WHERE role_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX grants_member ON grants(member_id,agent_id,project_id);
--> statement-breakpoint
CREATE INDEX grants_role ON grants(role_id,agent_id,project_id);
--> statement-breakpoint
CREATE INDEX grants_project ON grants(project_id);
--> statement-breakpoint
-- open: anyone who may use Agents can invoke it. granted: only the Owner and holders of Agent access.
ALTER TABLE agents ADD COLUMN access TEXT NOT NULL DEFAULT 'open' CHECK(access IN ('open','granted'));
