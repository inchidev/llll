-- Basic file storage uses immutable KV objects and a transactionally reserved D1 index.
CREATE TABLE file_objects (key TEXT PRIMARY KEY, storage_key TEXT NOT NULL UNIQUE, size INTEGER NOT NULL CHECK(size >= 0), etag TEXT NOT NULL, uploaded_at TEXT NOT NULL, metadata TEXT NOT NULL, copied INTEGER NOT NULL DEFAULT 0 CHECK(copied IN (0,1)));
--> statement-breakpoint
CREATE TABLE file_uploads (id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, size INTEGER NOT NULL CHECK(size >= 0), created_at TEXT NOT NULL);
--> statement-breakpoint
ALTER TABLE channels ADD COLUMN created_by TEXT REFERENCES users(id) ON DELETE SET NULL;
--> statement-breakpoint
UPDATE channels SET type='text', visibility='private', created_by=dm_owner_id, name=CASE WHEN name='dm' THEN 'private-chat-'||substr(id,1,8) ELSE name END WHERE type='dm' AND dm_kind='group';
--> statement-breakpoint
UPDATE channels SET created_by=(SELECT actor_id FROM audit_log WHERE action='channel.create' AND target_id=channels.id ORDER BY created_at LIMIT 1) WHERE type='text' AND created_by IS NULL;
--> statement-breakpoint
UPDATE agents SET harness='pi';
--> statement-breakpoint
CREATE TRIGGER agents_pi_only_insert AFTER INSERT ON agents WHEN NEW.harness <> 'pi' BEGIN UPDATE agents SET harness='pi' WHERE user_id=NEW.user_id; END;
--> statement-breakpoint
-- A grant includes history, but starts unread tracking at the grant's baseline.
CREATE TRIGGER channel_member_read_baseline AFTER INSERT ON channel_members BEGIN
  INSERT INTO channel_reads(channel_id,user_id,last_read_message_id,updated_at)
  SELECT c.id,NEW.user_id,MAX(m.id),NEW.joined_at FROM channels c JOIN messages m ON m.channel_id=c.id
  WHERE c.id=NEW.channel_id OR c.parent_id=NEW.channel_id GROUP BY c.id
  ON CONFLICT(channel_id,user_id) DO UPDATE SET last_read_message_id=excluded.last_read_message_id;
END;
--> statement-breakpoint
CREATE TRIGGER member_read_baseline_insert AFTER INSERT ON users WHEN NEW.status='active' BEGIN
  INSERT OR IGNORE INTO channel_reads(channel_id,user_id,last_read_message_id,updated_at)
  SELECT c.id,NEW.id,MAX(m.id),NEW.updated_at FROM channels c JOIN messages m ON m.channel_id=c.id
  LEFT JOIN channels parent ON parent.id=c.parent_id
  WHERE COALESCE(parent.visibility,c.visibility)='server' AND m.created_at<=COALESCE(NEW.joined_at,NEW.created_at) GROUP BY c.id;
END;
--> statement-breakpoint
CREATE TRIGGER member_read_baseline_activate AFTER UPDATE OF status ON users WHEN NEW.status='active' AND OLD.status<>'active' BEGIN
  INSERT INTO channel_reads(channel_id,user_id,last_read_message_id,updated_at)
  SELECT c.id,NEW.id,MAX(m.id),NEW.updated_at FROM channels c JOIN messages m ON m.channel_id=c.id
  LEFT JOIN channels parent ON parent.id=c.parent_id
  WHERE COALESCE(parent.visibility,c.visibility)='server' AND m.created_at<=COALESCE(NEW.joined_at,NEW.created_at) GROUP BY c.id
  ON CONFLICT(channel_id,user_id) DO UPDATE SET last_read_message_id=excluded.last_read_message_id;
END;
--> statement-breakpoint
INSERT OR IGNORE INTO channel_reads(channel_id,user_id,last_read_message_id,updated_at)
SELECT c.id,u.id,MAX(m.id),u.updated_at FROM users u CROSS JOIN channels c
LEFT JOIN channels parent ON parent.id=c.parent_id
LEFT JOIN channel_members cm ON cm.channel_id=COALESCE(c.parent_id,c.id) AND cm.user_id=u.id
JOIN messages m ON m.channel_id=c.id
WHERE u.status='active' AND (COALESCE(parent.visibility,c.visibility)='server' OR cm.user_id IS NOT NULL)
AND m.created_at<=MAX(COALESCE(u.joined_at,u.created_at),COALESCE(cm.joined_at,u.joined_at,u.created_at))
GROUP BY c.id,u.id;
