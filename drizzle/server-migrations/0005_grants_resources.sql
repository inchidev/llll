-- Channel, mailbox, App and MCP connection access move into grants. A grant now gives a
-- Member or Role either a Policy (Projects, Agent access) or a set of permissions on one
-- resource. Channel denies stay in their own table: grants only add permissions.
DROP VIEW project_policy_assignments;
--> statement-breakpoint
CREATE TABLE grants_next (
  id TEXT PRIMARY KEY NOT NULL,
  member_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  role_id TEXT REFERENCES roles(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(user_id) ON DELETE CASCADE,
  policy_id TEXT REFERENCES project_policies(id) ON DELETE CASCADE,
  permissions INTEGER CHECK(permissions IS NULL OR permissions > 0),
  -- One scope at most. None means the whole Server, which only Agent access may use.
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  channel_id TEXT REFERENCES channels(id) ON DELETE CASCADE,
  mailbox_id TEXT REFERENCES email_mailboxes(channel_id) ON DELETE CASCADE,
  gadget_id TEXT REFERENCES gadgets(id) ON DELETE CASCADE,
  gadget_version_id TEXT REFERENCES gadget_versions(id) ON DELETE CASCADE,
  connection_id TEXT REFERENCES mcp_outbound_connections(id) ON DELETE CASCADE,
  daily_runs INTEGER CHECK(daily_runs IS NULL OR daily_runs BETWEEN 1 AND 10000),
  expires_at TEXT,
  -- NULL only for access that was recorded before grants kept their creator.
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  CHECK((member_id IS NOT NULL AND role_id IS NULL) OR (role_id IS NOT NULL AND member_id IS NULL)),
  CHECK((policy_id IS NULL) <> (permissions IS NULL)),
  CHECK((project_id IS NOT NULL) + (channel_id IS NOT NULL) + (mailbox_id IS NOT NULL) + (gadget_id IS NOT NULL) + (gadget_version_id IS NOT NULL) + (connection_id IS NOT NULL) <= 1),
  CHECK(agent_id IS NOT NULL OR project_id IS NOT NULL OR channel_id IS NOT NULL OR mailbox_id IS NOT NULL OR gadget_id IS NOT NULL OR gadget_version_id IS NOT NULL OR connection_id IS NOT NULL),
  CHECK(agent_id IS NOT NULL OR (daily_runs IS NULL AND expires_at IS NULL)),
  -- Policies apply to Projects and Agent access; resource grants carry their own permissions.
  CHECK((policy_id IS NOT NULL) = (channel_id IS NULL AND mailbox_id IS NULL AND gadget_id IS NULL AND gadget_version_id IS NULL AND connection_id IS NULL)),
  -- Channel: a Role may send, attach files or start Live (sendMessages, attachFiles, startLive).
  CHECK(channel_id IS NULL OR (role_id IS NOT NULL AND (permissions & ~112) = 0)),
  -- Mailbox: a Member reads (readMail), sends (+ sendMail) or manages it (+ manageChannels).
  CHECK(mailbox_id IS NULL OR (member_id IS NOT NULL AND permissions IN (536870912, 1610612736, 1610612738))),
  -- Apps: a Role may use a draft or a published version (useGadgets).
  CHECK((gadget_id IS NULL AND gadget_version_id IS NULL) OR (role_id IS NOT NULL AND permissions = 1024)),
  -- MCP connection: a Member, Agent or Role may use it (useExternalTools).
  CHECK(connection_id IS NULL OR permissions = 33554432)
);
--> statement-breakpoint
INSERT INTO grants_next(id,member_id,role_id,agent_id,policy_id,project_id,daily_runs,expires_at,created_by,created_at)
  SELECT id,member_id,role_id,agent_id,policy_id,project_id,daily_runs,expires_at,created_by,created_at FROM grants;
--> statement-breakpoint
INSERT INTO grants_next(id,role_id,permissions,channel_id,created_at)
  SELECT lower(hex(randomblob(16))),role_id,allow_mask,channel_id,created_at FROM channel_role_overrides WHERE allow_mask <> 0;
--> statement-breakpoint
CREATE TABLE channel_role_denies (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  deny_mask INTEGER NOT NULL CHECK(deny_mask > 0 AND (deny_mask & ~112) = 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY(channel_id, role_id)
);
--> statement-breakpoint
INSERT INTO channel_role_denies(channel_id,role_id,deny_mask,created_at)
  SELECT channel_id,role_id,deny_mask,created_at FROM channel_role_overrides WHERE deny_mask <> 0;
--> statement-breakpoint
INSERT INTO grants_next(id,member_id,permissions,mailbox_id,created_at)
  SELECT lower(hex(randomblob(16))),user_id,
    CASE permission WHEN 'manage' THEN 1610612738 WHEN 'send' THEN 1610612736 ELSE 536870912 END,
    channel_id,created_at FROM email_mailbox_access;
--> statement-breakpoint
INSERT INTO grants_next(id,role_id,permissions,gadget_id,created_at)
  SELECT lower(hex(randomblob(16))),role_id,1024,gadget_id,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM gadget_draft_role_access;
--> statement-breakpoint
INSERT INTO grants_next(id,role_id,permissions,gadget_version_id,created_at)
  SELECT lower(hex(randomblob(16))),role_id,1024,gadget_version_id,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM gadget_version_role_access;
--> statement-breakpoint
-- grants_json lists Agent and Member IDs (both users) and Role IDs. IDs whose user or Role
-- no longer exists granted nothing and are dropped.
INSERT INTO grants_next(id,member_id,permissions,connection_id,created_by,created_at)
  SELECT lower(hex(randomblob(16))),v.subject,33554432,v.id,v.created_by,v.updated_at FROM (
    SELECT DISTINCT c.id,c.created_by,c.updated_at,j.value AS subject
    FROM mcp_outbound_connections c, json_each(c.grants_json) g, json_each(g.value) j
    WHERE g.key IN ('agentIds','memberIds')
  ) v WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = v.subject);
--> statement-breakpoint
INSERT INTO grants_next(id,role_id,permissions,connection_id,created_by,created_at)
  SELECT lower(hex(randomblob(16))),v.subject,33554432,v.id,v.created_by,v.updated_at FROM (
    SELECT DISTINCT c.id,c.created_by,c.updated_at,j.value AS subject
    FROM mcp_outbound_connections c, json_each(c.grants_json, '$.roleIds') j
  ) v WHERE EXISTS (SELECT 1 FROM roles r WHERE r.id = v.subject);
--> statement-breakpoint
DROP TABLE grants;
--> statement-breakpoint
ALTER TABLE grants_next RENAME TO grants;
--> statement-breakpoint
DROP TABLE channel_role_overrides;
--> statement-breakpoint
DROP TABLE email_mailbox_access;
--> statement-breakpoint
DROP TABLE gadget_draft_role_access;
--> statement-breakpoint
DROP TABLE gadget_version_role_access;
--> statement-breakpoint
CREATE UNIQUE INDEX grants_member_identity ON grants(member_id,coalesce(agent_id,''),coalesce(project_id,''),policy_id) WHERE member_id IS NOT NULL AND policy_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX grants_role_identity ON grants(role_id,coalesce(agent_id,''),coalesce(project_id,''),policy_id) WHERE role_id IS NOT NULL AND policy_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX grants_channel_identity ON grants(channel_id,role_id) WHERE channel_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX grants_mailbox_identity ON grants(mailbox_id,member_id) WHERE mailbox_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX grants_gadget_identity ON grants(gadget_id,role_id) WHERE gadget_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX grants_gadget_version_identity ON grants(gadget_version_id,role_id) WHERE gadget_version_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX grants_connection_identity ON grants(connection_id,coalesce(member_id,''),coalesce(role_id,'')) WHERE connection_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX grants_member ON grants(member_id,agent_id,project_id);
--> statement-breakpoint
CREATE INDEX grants_role ON grants(role_id,agent_id,project_id);
--> statement-breakpoint
CREATE INDEX grants_project ON grants(project_id);
--> statement-breakpoint
CREATE INDEX grants_member_mailbox ON grants(member_id,mailbox_id) WHERE mailbox_id IS NOT NULL;
--> statement-breakpoint
-- An update applies migrations before the new code is uploaded, so the previous release
-- briefly runs on this schema. These read-only views keep its reads working under the old
-- names; its writes to them fail until the new code is active. A later migration removes them.
CREATE VIEW project_policy_assignments AS
  SELECT id,project_id,policy_id,member_id,role_id,created_by,created_at FROM grants WHERE agent_id IS NULL AND project_id IS NOT NULL;
--> statement-breakpoint
CREATE VIEW channel_role_overrides AS
  SELECT channel_id,role_id,max(allow_mask) AS allow_mask,max(deny_mask) AS deny_mask,min(created_at) AS created_at,max(created_at) AS updated_at FROM (
    SELECT channel_id,role_id,permissions AS allow_mask,0 AS deny_mask,created_at FROM grants WHERE channel_id IS NOT NULL
    UNION ALL SELECT channel_id,role_id,0,deny_mask,created_at FROM channel_role_denies
  ) GROUP BY channel_id,role_id;
--> statement-breakpoint
CREATE VIEW email_mailbox_access AS
  SELECT mailbox_id AS channel_id,member_id AS user_id,
    CASE WHEN permissions & 2 THEN 'manage' WHEN permissions & 1073741824 THEN 'send' ELSE 'read' END AS permission,
    created_at,created_at AS updated_at
  FROM grants WHERE mailbox_id IS NOT NULL;
--> statement-breakpoint
CREATE VIEW gadget_draft_role_access AS SELECT gadget_id,role_id FROM grants WHERE gadget_id IS NOT NULL;
--> statement-breakpoint
CREATE VIEW gadget_version_role_access AS SELECT gadget_version_id,role_id FROM grants WHERE gadget_version_id IS NOT NULL;
