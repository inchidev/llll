ALTER TABLE `tasks` ADD `parent_task_id` text REFERENCES tasks(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `tasks_parent_idx` ON `tasks` (`parent_task_id`);
--> statement-breakpoint
CREATE TRIGGER tasks_hierarchy_insert BEFORE INSERT ON tasks
BEGIN
  SELECT RAISE(ABORT, 'task_hierarchy_boundary') WHERE NEW.parent_task_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM tasks p WHERE p.id=NEW.parent_task_id AND p.board_id=NEW.board_id AND p.project_id IS NEW.project_id
  );
  SELECT RAISE(ABORT, 'task_hierarchy_cycle') WHERE NEW.parent_task_id IS NOT NULL AND EXISTS (
    WITH RECURSIVE ancestors(id) AS (
      SELECT NEW.parent_task_id UNION SELECT t.parent_task_id FROM tasks t JOIN ancestors a ON t.id=a.id WHERE t.parent_task_id IS NOT NULL
    ) SELECT 1 FROM ancestors WHERE id=NEW.id
  );
  SELECT RAISE(ABORT, 'task_hierarchy_archived') WHERE EXISTS (
    SELECT 1 FROM tasks p WHERE p.id=NEW.parent_task_id AND p.archived_at IS NOT NULL
  );
END;

--> statement-breakpoint
CREATE TRIGGER tasks_hierarchy_update BEFORE UPDATE OF parent_task_id, board_id, project_id ON tasks
BEGIN
  SELECT RAISE(ABORT, 'task_hierarchy_boundary') WHERE NEW.parent_task_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM tasks p WHERE p.id=NEW.parent_task_id AND p.board_id=NEW.board_id AND p.project_id IS NEW.project_id
  );
  SELECT RAISE(ABORT, 'task_hierarchy_cycle') WHERE NEW.parent_task_id IS NOT NULL AND EXISTS (
    WITH RECURSIVE ancestors(id) AS (
      SELECT NEW.parent_task_id UNION SELECT t.parent_task_id FROM tasks t JOIN ancestors a ON t.id=a.id WHERE t.parent_task_id IS NOT NULL
    ) SELECT 1 FROM ancestors WHERE id=NEW.id
  );
  SELECT RAISE(ABORT, 'task_hierarchy_children') WHERE EXISTS (
    SELECT 1 FROM tasks c WHERE c.parent_task_id=NEW.id AND (c.board_id<>NEW.board_id OR c.project_id IS NOT NEW.project_id)
  );
  SELECT RAISE(ABORT, 'task_hierarchy_archived') WHERE NEW.parent_task_id IS NOT OLD.parent_task_id AND EXISTS (
    SELECT 1 FROM tasks p WHERE p.id=NEW.parent_task_id AND p.archived_at IS NOT NULL
  );
END;
--> statement-breakpoint
CREATE TABLE `channel_attention` (
	`channel_id` text NOT NULL,
	`user_id` text NOT NULL,
	`following` integer DEFAULT false NOT NULL,
	`notifications` text DEFAULT 'default' NOT NULL,
	`read_generation` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`channel_id`, `user_id`),
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "channel_attention_notifications_check" CHECK("channel_attention"."notifications" in ('default', 'all', 'mentions', 'muted'))
);
--> statement-breakpoint
CREATE INDEX `channel_attention_user_idx` ON `channel_attention` (`user_id`,`following`);
--> statement-breakpoint
-- Keep existing thread subscriptions across the upgrade. New reads do not subscribe.
INSERT INTO channel_attention(channel_id, user_id, following)
SELECT r.channel_id, r.user_id, 1 FROM channel_reads r JOIN channels c ON c.id = r.channel_id
WHERE c.type = 'thread' AND r.last_read_message_id IS NOT NULL;
--> statement-breakpoint
DROP TRIGGER IF EXISTS canvas_bookmarks_after_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS document_bookmarks_after_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS database_view_bookmarks_after_delete;
--> statement-breakpoint
CREATE TABLE `new_data_bookmarks` (
	`user_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`user_id`, `target_type`, `target_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `data_bookmarks_target_type_check` CHECK(`target_type` in ('database_view', 'item'))
);
--> statement-breakpoint
INSERT INTO new_data_bookmarks SELECT user_id,CASE WHEN target_type='database_view' THEN target_type ELSE 'item' END,target_id,position,created_at FROM data_bookmarks;
--> statement-breakpoint
DROP TABLE data_bookmarks;
--> statement-breakpoint
ALTER TABLE new_data_bookmarks RENAME TO data_bookmarks;
--> statement-breakpoint
CREATE INDEX `data_bookmarks_user_position_idx` ON `data_bookmarks` (`user_id`,`position`,`created_at`);
--> statement-breakpoint
DROP TRIGGER IF EXISTS data_references_document_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS data_references_record_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS data_references_database_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS data_references_canvas_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS data_references_task_delete;
--> statement-breakpoint
CREATE TABLE new_data_references (
	source_type TEXT NOT NULL,
	source_id TEXT NOT NULL,
	target_type TEXT NOT NULL,
	target_id TEXT NOT NULL,
	created_by TEXT NOT NULL REFERENCES users(id),
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	PRIMARY KEY(source_type, source_id, target_type, target_id),
	CHECK(source_type IN ('item','document','record','database','canvas','task')),
	CHECK(target_type IN ('item','document','record','database','canvas','task'))
);
--> statement-breakpoint
INSERT INTO new_data_references SELECT * FROM data_references;
--> statement-breakpoint
DROP TABLE data_references;
--> statement-breakpoint
ALTER TABLE new_data_references RENAME TO data_references;
--> statement-breakpoint
CREATE INDEX data_references_target_idx ON data_references(target_type,target_id);
--> statement-breakpoint
-- Generated table definitions, followed by the Item migration and invariants.
DROP TRIGGER IF EXISTS audit_log_finds_space;
--> statement-breakpoint
DROP TRIGGER IF EXISTS canvas_bookmarks_after_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS document_bookmarks_after_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS document_revision_before_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS data_references_document_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS data_references_record_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS data_references_canvas_delete;
--> statement-breakpoint
DROP INDEX IF EXISTS database_items_database_position_idx;
--> statement-breakpoint
DROP INDEX IF EXISTS database_items_active_position_idx;
--> statement-breakpoint
CREATE TABLE `data_items` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text DEFAULT '00000000-0000-4000-8000-00000000000d' NOT NULL,
	`kind` text DEFAULT 'page' NOT NULL,
	`parent_id` text,
	`content` text DEFAULT '' NOT NULL,
	`icon` text,
	`deleted_at` text,
	`mutation_id` text,
	`database_id` text,
	`title` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_by` text NOT NULL,
	`text_1` text,
	`text_2` text,
	`text_3` text,
	`text_4` text,
	`text_5` text,
	`text_6` text,
	`text_7` text,
	`text_8` text,
	`text_9` text,
	`text_10` text,
	`text_11` text,
	`text_12` text,
	`text_13` text,
	`text_14` text,
	`text_15` text,
	`text_16` text,
	`number_1` real,
	`number_2` real,
	`number_3` real,
	`number_4` real,
	`number_5` real,
	`number_6` real,
	`number_7` real,
	`number_8` real,
	`boolean_1` integer,
	`boolean_2` integer,
	`boolean_3` integer,
	`boolean_4` integer,
	`boolean_5` integer,
	`boolean_6` integer,
	`boolean_7` integer,
	`boolean_8` integer,
	`date_1` text,
	`date_2` text,
	`date_3` text,
	`date_4` text,
	`date_5` text,
	`date_6` text,
	`date_7` text,
	`date_8` text,
	`select_1` text,
	`select_2` text,
	`select_3` text,
	`select_4` text,
	`select_5` text,
	`select_6` text,
	`select_7` text,
	`select_8` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `data_items`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`database_id`) REFERENCES `database_definitions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "data_items_kind_check" CHECK("data_items"."kind" in ('page', 'canvas')),
	CONSTRAINT "database_items_version_check" CHECK("data_items"."version" > 0)
);
--> statement-breakpoint
INSERT INTO data_items (id,database_id,title,position,version,created_by,text_1,text_2,text_3,text_4,text_5,text_6,text_7,text_8,text_9,text_10,text_11,text_12,text_13,text_14,text_15,text_16,number_1,number_2,number_3,number_4,number_5,number_6,number_7,number_8,boolean_1,boolean_2,boolean_3,boolean_4,boolean_5,boolean_6,boolean_7,boolean_8,date_1,date_2,date_3,date_4,date_5,date_6,date_7,date_8,select_1,select_2,select_3,select_4,select_5,select_6,select_7,select_8,created_at,updated_at,space_id,deleted_at,mutation_id) SELECT i.id,i.database_id,i.title,i.position,i.version,i.created_by,i.text_1,i.text_2,i.text_3,i.text_4,i.text_5,i.text_6,i.text_7,i.text_8,i.text_9,i.text_10,i.text_11,i.text_12,i.text_13,i.text_14,i.text_15,i.text_16,i.number_1,i.number_2,i.number_3,i.number_4,i.number_5,i.number_6,i.number_7,i.number_8,i.boolean_1,i.boolean_2,i.boolean_3,i.boolean_4,i.boolean_5,i.boolean_6,i.boolean_7,i.boolean_8,i.date_1,i.date_2,i.date_3,i.date_4,i.date_5,i.date_6,i.date_7,i.date_8,i.select_1,i.select_2,i.select_3,i.select_4,i.select_5,i.select_6,i.select_7,i.select_8,i.created_at,i.updated_at,d.space_id,i.deleted_at,i.mutation_id FROM database_items i JOIN database_definitions d ON d.id=i.database_id;
--> statement-breakpoint
INSERT INTO data_items(id,space_id,kind,title,content,position,version,created_by,created_at,updated_at,deleted_at) SELECT id,space_id,'page',title,content,position,version,created_by,created_at,updated_at,deleted_at FROM documents;
--> statement-breakpoint
INSERT INTO data_items(id,space_id,kind,title,position,version,created_by,created_at,updated_at,deleted_at) SELECT id,space_id,'canvas',title,position,version,created_by,created_at,updated_at,deleted_at FROM canvases;
--> statement-breakpoint
DROP INDEX IF EXISTS `canvas_edges_nodes_unique`;
--> statement-breakpoint
DROP INDEX IF EXISTS `canvas_edges_canvas_idx`;
--> statement-breakpoint
ALTER TABLE canvas_edges RENAME TO legacy_canvas_edges;
--> statement-breakpoint
DROP INDEX IF EXISTS `canvas_nodes_canvas_idx`;
--> statement-breakpoint
ALTER TABLE canvas_nodes RENAME TO legacy_canvas_nodes;
--> statement-breakpoint
ALTER TABLE data_record_requests RENAME TO legacy_data_record_requests;
--> statement-breakpoint
DROP INDEX IF EXISTS `database_item_links_unique`;
--> statement-breakpoint
DROP INDEX IF EXISTS `database_item_links_item_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `database_item_links_target_idx`;
--> statement-breakpoint
ALTER TABLE database_item_links RENAME TO legacy_database_item_links;
--> statement-breakpoint
ALTER TABLE document_revisions RENAME TO legacy_document_revisions;
--> statement-breakpoint
CREATE TABLE `canvas_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`canvas_id` text NOT NULL,
	`kind` text DEFAULT 'note' NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`x` real DEFAULT 0 NOT NULL,
	`y` real DEFAULT 0 NOT NULL,
	`width` real DEFAULT 240 NOT NULL,
	`height` real DEFAULT 144 NOT NULL,
	`color` text DEFAULT 'neutral' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`canvas_id`) REFERENCES `data_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "canvas_nodes_kind_check" CHECK("canvas_nodes"."kind" in ('note', 'text')),
	CONSTRAINT "canvas_nodes_color_check" CHECK("canvas_nodes"."color" in ('neutral', 'orange', 'blue', 'green', 'red')),
	CONSTRAINT "canvas_nodes_version_check" CHECK("canvas_nodes"."version" > 0)
);
--> statement-breakpoint
INSERT INTO canvas_nodes (id,canvas_id,kind,content,x,y,width,height,color,version,created_by,created_at,updated_at) SELECT id,canvas_id,kind,content,x,y,width,height,color,version,created_by,created_at,updated_at FROM legacy_canvas_nodes;
--> statement-breakpoint
CREATE TABLE `canvas_edges` (
	`id` text PRIMARY KEY NOT NULL,
	`canvas_id` text NOT NULL,
	`from_node_id` text NOT NULL,
	`to_node_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`canvas_id`) REFERENCES `data_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`from_node_id`) REFERENCES `canvas_nodes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_node_id`) REFERENCES `canvas_nodes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "canvas_edges_not_self_check" CHECK("canvas_edges"."from_node_id" <> "canvas_edges"."to_node_id")
);
--> statement-breakpoint
INSERT INTO canvas_edges (id,canvas_id,from_node_id,to_node_id,created_by,created_at) SELECT id,canvas_id,from_node_id,to_node_id,created_by,created_at FROM legacy_canvas_edges;
--> statement-breakpoint
CREATE TABLE `data_record_requests` (
	`principal_id` text NOT NULL,
	`database_id` text NOT NULL,
	`request_id` text NOT NULL,
	`record_id` text,
	`body_hash` text NOT NULL,
	PRIMARY KEY(`principal_id`, `database_id`, `request_id`),
	FOREIGN KEY (`principal_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`database_id`) REFERENCES `database_definitions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`record_id`) REFERENCES `data_items`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO data_record_requests (principal_id,database_id,request_id,record_id,body_hash) SELECT principal_id,database_id,request_id,record_id,body_hash FROM legacy_data_record_requests;
--> statement-breakpoint
CREATE TABLE `database_item_links` (
	`id` text PRIMARY KEY NOT NULL,
	`field_id` text NOT NULL,
	`item_id` text NOT NULL,
	`target_item_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`field_id`) REFERENCES `database_fields`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `data_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_item_id`) REFERENCES `data_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO database_item_links (id,field_id,item_id,target_item_id,position,created_at) SELECT id,field_id,item_id,target_item_id,position,created_at FROM legacy_database_item_links;
--> statement-breakpoint
CREATE TABLE `document_revisions` (
	`document_id` text NOT NULL,
	`version` integer NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`saved_at` text NOT NULL,
	PRIMARY KEY(`document_id`, `version`),
	FOREIGN KEY (`document_id`) REFERENCES `data_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO document_revisions (document_id,version,title,content,saved_at) SELECT document_id,version,title,content,saved_at FROM legacy_document_revisions;
--> statement-breakpoint
DROP TABLE legacy_canvas_edges;
--> statement-breakpoint
DROP TABLE legacy_canvas_nodes;
--> statement-breakpoint
DROP TABLE legacy_data_record_requests;
--> statement-breakpoint
DROP TABLE legacy_database_item_links;
--> statement-breakpoint
DROP TABLE legacy_document_revisions;
--> statement-breakpoint
DROP TABLE database_items;
--> statement-breakpoint
DROP TABLE documents;
--> statement-breakpoint
DROP TABLE canvases;
--> statement-breakpoint
CREATE INDEX `data_items_parent_idx` ON `data_items` (`space_id`,`parent_id`,`position`);
--> statement-breakpoint
CREATE INDEX `data_items_parent_id_idx` ON `data_items` (`parent_id`);
--> statement-breakpoint
CREATE INDEX `database_items_database_position_idx` ON `data_items` (`database_id`,`position`);
--> statement-breakpoint
CREATE INDEX `database_items_active_position_idx` ON `data_items` (`database_id`,`position`,`created_at`,`id`) WHERE "data_items"."deleted_at" is null;
--> statement-breakpoint
CREATE UNIQUE INDEX `canvas_edges_nodes_unique` ON `canvas_edges` (`canvas_id`,`from_node_id`,`to_node_id`);
--> statement-breakpoint
CREATE INDEX `canvas_edges_canvas_idx` ON `canvas_edges` (`canvas_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `canvas_nodes_canvas_idx` ON `canvas_nodes` (`canvas_id`,`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `database_item_links_unique` ON `database_item_links` (`field_id`,`item_id`,`target_item_id`);
--> statement-breakpoint
CREATE INDEX `database_item_links_item_idx` ON `database_item_links` (`item_id`,`field_id`,`position`);
--> statement-breakpoint
CREATE INDEX `database_item_links_target_idx` ON `database_item_links` (`target_item_id`);
--> statement-breakpoint
CREATE TRIGGER audit_log_finds_space AFTER INSERT ON audit_log WHEN NEW.space_id IS NULL AND NEW.target_type NOT IN ('server', 'user', 'role', 'policy', 'ai_function', 'agent_provider', 'onboarding_revision', 'git_connection', 'mcp_connection')
BEGIN
  UPDATE audit_log SET space_id = COALESCE(CASE NEW.target_type
    WHEN 'space' THEN NEW.target_id
    WHEN 'channel' THEN (SELECT space_id FROM channels WHERE id = NEW.target_id)
    WHEN 'mailbox' THEN (SELECT space_id FROM channels WHERE id = NEW.target_id)
    WHEN 'email_thread' THEN (SELECT space_id FROM channels WHERE id = NEW.target_id)
    WHEN 'channel_category' THEN (SELECT space_id FROM channel_categories WHERE id = NEW.target_id)
    WHEN 'message' THEN (SELECT c.space_id FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.id = NEW.target_id)
    WHEN 'project' THEN (SELECT space_id FROM projects WHERE id = NEW.target_id)
    WHEN 'task_board' THEN (SELECT space_id FROM task_boards WHERE id = NEW.target_id)
    WHEN 'task' THEN (SELECT b.space_id FROM tasks t JOIN task_boards b ON b.id = t.board_id WHERE t.id = NEW.target_id)
    WHEN 'task_label' THEN (SELECT b.space_id FROM task_labels l JOIN task_boards b ON b.id = l.board_id WHERE l.id = NEW.target_id)
    WHEN 'database' THEN (SELECT space_id FROM database_definitions WHERE id = NEW.target_id)
    WHEN 'database_item' THEN (SELECT d.space_id FROM data_items i JOIN database_definitions d ON d.id = i.database_id WHERE i.id = NEW.target_id)
    WHEN 'database_field' THEN (SELECT d.space_id FROM database_fields f JOIN database_definitions d ON d.id = f.database_id WHERE f.id = NEW.target_id)
    WHEN 'database_view' THEN (SELECT d.space_id FROM database_views v JOIN database_definitions d ON d.id = v.database_id WHERE v.id = NEW.target_id)
    WHEN 'item' THEN (SELECT space_id FROM data_items WHERE id = NEW.target_id)
    WHEN 'document' THEN (SELECT space_id FROM data_items WHERE id = NEW.target_id)
    WHEN 'canvas' THEN (SELECT space_id FROM data_items WHERE id = NEW.target_id)
    WHEN 'canvas_node' THEN (SELECT c.space_id FROM canvas_nodes n JOIN data_items c ON c.id = n.canvas_id WHERE n.id = NEW.target_id)
    WHEN 'canvas_edge' THEN (SELECT c.space_id FROM canvas_edges e JOIN data_items c ON c.id = e.canvas_id WHERE e.id = NEW.target_id)
    WHEN 'gadget' THEN (SELECT space_id FROM gadgets WHERE id = NEW.target_id)
    WHEN 'tool_connection' THEN (SELECT space_id FROM mcp_outbound_connections WHERE id = NEW.target_id)
    WHEN 'environment' THEN (SELECT space_id FROM agent_environments WHERE id = NEW.target_id)
    WHEN 'invite' THEN (SELECT space_id FROM invites WHERE code = NEW.target_id)
    WHEN 'run' THEN (SELECT c.space_id FROM agent_runs r JOIN channels c ON c.id = r.channel_id WHERE r.id = NEW.target_id)
    WHEN 'agent' THEN (SELECT space_id FROM space_members WHERE user_id = NEW.target_id LIMIT 1)
    WHEN 'mcp_token' THEN (SELECT m.space_id FROM mcp_access_tokens t JOIN space_members m ON m.user_id = t.subject_id WHERE t.id = NEW.target_id LIMIT 1)
  END, (SELECT MIN(space_id) FROM space_members WHERE user_id = NEW.actor_id HAVING COUNT(*) = 1)) WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER document_revision_before_update BEFORE UPDATE OF title, content ON data_items
WHEN OLD.title <> NEW.title OR OLD.content <> NEW.content
BEGIN
  INSERT INTO document_revisions(document_id,version,title,content,saved_at)
  VALUES(OLD.id,OLD.version,OLD.title,OLD.content,OLD.updated_at);
  DELETE FROM document_revisions WHERE document_id=OLD.id AND version NOT IN
    (SELECT version FROM document_revisions WHERE document_id=OLD.id ORDER BY version DESC LIMIT 50);
END;
--> statement-breakpoint
CREATE TRIGGER data_item_cleanup AFTER DELETE ON data_items BEGIN
 DELETE FROM data_bookmarks WHERE target_id=OLD.id AND target_type='item';
 DELETE FROM data_references WHERE (source_type IN ('item','record','document','canvas') AND source_id=OLD.id) OR (target_type IN ('item','record','document','canvas') AND target_id=OLD.id);
END;
--> statement-breakpoint
CREATE TRIGGER data_item_insert_scope BEFORE INSERT ON data_items BEGIN
 SELECT CASE WHEN NEW.database_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM database_definitions d WHERE d.id=NEW.database_id AND d.space_id=NEW.space_id AND d.deleted_at IS NULL AND d.archived_at IS NULL) THEN RAISE(ABORT,'item_database_scope') END;
 SELECT CASE WHEN NEW.parent_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM data_items p WHERE p.id=NEW.parent_id AND p.space_id=NEW.space_id AND p.deleted_at IS NULL) THEN RAISE(ABORT,'item_parent_scope') END;
 SELECT CASE WHEN NEW.parent_id IS NOT NULL AND EXISTS(WITH RECURSIVE ancestors(id,parent_id) AS (SELECT id,parent_id FROM data_items WHERE id=NEW.parent_id UNION SELECT p.id,p.parent_id FROM data_items p JOIN ancestors a ON p.id=a.parent_id) SELECT 1 FROM ancestors WHERE id=NEW.id) THEN RAISE(ABORT,'item_parent_cycle') END;
END;
--> statement-breakpoint
CREATE TRIGGER data_item_move_scope BEFORE UPDATE OF parent_id,database_id,space_id,kind ON data_items BEGIN
 SELECT CASE WHEN NEW.database_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM database_definitions d WHERE d.id=NEW.database_id AND d.space_id=NEW.space_id AND d.deleted_at IS NULL AND d.archived_at IS NULL) THEN RAISE(ABORT,'item_database_scope') END;
 SELECT CASE WHEN NEW.parent_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM data_items p WHERE p.id=NEW.parent_id AND p.space_id=NEW.space_id AND p.deleted_at IS NULL) THEN RAISE(ABORT,'item_parent_scope') END;
 SELECT CASE WHEN NEW.parent_id IS NOT NULL AND EXISTS(WITH RECURSIVE ancestors(id,parent_id) AS (SELECT id,parent_id FROM data_items WHERE id=NEW.parent_id UNION SELECT p.id,p.parent_id FROM data_items p JOIN ancestors a ON p.id=a.parent_id) SELECT 1 FROM ancestors WHERE id=NEW.id) THEN RAISE(ABORT,'item_parent_cycle') END;
END;
--> statement-breakpoint
CREATE TRIGGER data_item_identity BEFORE UPDATE OF space_id,kind ON data_items
WHEN OLD.space_id<>NEW.space_id OR OLD.kind<>NEW.kind BEGIN SELECT RAISE(ABORT,'item_identity_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER canvas_nodes_item_insert BEFORE INSERT ON canvas_nodes WHEN NOT EXISTS(SELECT 1 FROM data_items WHERE id=NEW.canvas_id AND kind='canvas' AND deleted_at IS NULL) BEGIN SELECT RAISE(ABORT,'canvas_item_required'); END;
--> statement-breakpoint
CREATE TRIGGER canvas_edges_item_insert BEFORE INSERT ON canvas_edges WHEN NOT EXISTS(SELECT 1 FROM data_items WHERE id=NEW.canvas_id AND kind='canvas' AND deleted_at IS NULL) BEGIN SELECT RAISE(ABORT,'canvas_item_required'); END;
--> statement-breakpoint
CREATE TRIGGER canvas_nodes_item_update BEFORE UPDATE OF canvas_id ON canvas_nodes WHEN NOT EXISTS(SELECT 1 FROM data_items WHERE id=NEW.canvas_id AND kind='canvas' AND deleted_at IS NULL) BEGIN SELECT RAISE(ABORT,'canvas_item_required'); END;
--> statement-breakpoint
CREATE TRIGGER canvas_edges_item_update BEFORE UPDATE OF canvas_id ON canvas_edges WHEN NOT EXISTS(SELECT 1 FROM data_items WHERE id=NEW.canvas_id AND kind='canvas' AND deleted_at IS NULL) BEGIN SELECT RAISE(ABORT,'canvas_item_required'); END;
--> statement-breakpoint
UPDATE data_references SET source_type='item' WHERE source_type IN ('document','record','canvas');
--> statement-breakpoint
UPDATE data_references SET target_type='item' WHERE target_type IN ('document','record','canvas');

--> statement-breakpoint
CREATE TRIGGER data_references_database_delete AFTER DELETE ON database_definitions BEGIN
  DELETE FROM data_references WHERE (source_type='database' AND source_id=OLD.id) OR (target_type='database' AND target_id=OLD.id);
END;
--> statement-breakpoint
CREATE TRIGGER data_references_task_delete AFTER DELETE ON tasks BEGIN
  DELETE FROM data_references WHERE (source_type='task' AND source_id=OLD.id) OR (target_type='task' AND target_id=OLD.id);
END;
--> statement-breakpoint

--> statement-breakpoint
CREATE TRIGGER database_view_bookmarks_after_delete AFTER DELETE ON database_views BEGIN DELETE FROM data_bookmarks WHERE target_type='database_view' AND target_id=OLD.id; END;
