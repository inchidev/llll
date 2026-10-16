CREATE TABLE `agent_turns` (
	`submission_id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`source_message_id` text NOT NULL,
	`initiated_by` text NOT NULL,
	`request_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`detail` text,
	`draft_message_id` text,
	`approval_json` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`user_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`initiated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`draft_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "agent_turns_status_check" CHECK("agent_turns"."status" in ('queued', 'thinking', 'tool', 'waiting_approval'))
);
--> statement-breakpoint
CREATE INDEX `agent_turns_channel_agent_idx` ON `agent_turns` (`channel_id`,`agent_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_turns_request_id_unique` ON `agent_turns` (`request_id`);--> statement-breakpoint
CREATE TABLE `agents` (
	`user_id` text PRIMARY KEY NOT NULL,
	`model` text DEFAULT '@cf/moonshotai/kimi-k2.7-code' NOT NULL,
	`instructions` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`computer_id` text NOT NULL,
	`created_by` text NOT NULL,
	`last_active_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agents_status_check" CHECK("agents"."status" in ('active', 'paused'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_computer_id_unique` ON `agents` (`computer_id`);--> statement-breakpoint
CREATE INDEX `agents_status_idx` ON `agents` (`status`);--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text,
	`channel_id` text NOT NULL,
	`uploader_id` text NOT NULL,
	`r2_key` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`width` integer,
	`height` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`uploader_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "attachments_size_check" CHECK("attachments"."size_bytes" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attachments_r2_key_unique` ON `attachments` (`r2_key`);--> statement-breakpoint
CREATE INDEX `attachments_message_id_idx` ON `attachments` (`message_id`);--> statement-breakpoint
CREATE INDEX `attachments_channel_id_idx` ON `attachments` (`channel_id`);--> statement-breakpoint
CREATE INDEX `attachments_uploader_id_idx` ON `attachments` (`uploader_id`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`meta_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `audit_log_created_at_idx` ON `audit_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `audit_log_actor_id_idx` ON `audit_log` (`actor_id`);--> statement-breakpoint
CREATE TABLE `auth_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`issuer` text DEFAULT 'local:credential' NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (cast(unixepoch() * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch() * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `identity_keys`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_accounts_issuer_account_idx` ON `auth_accounts` (`issuer`,`account_id`);--> statement-breakpoint
CREATE INDEX `auth_accounts_user_id_idx` ON `auth_accounts` (`user_id`);--> statement-breakpoint
CREATE TABLE `auth_provider_credentials` (
	`provider` text PRIMARY KEY NOT NULL,
	`public_key` text NOT NULL,
	`secret_ciphertext` text NOT NULL,
	`secret_iv` text NOT NULL,
	`secret_version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "auth_provider_credentials_provider_check" CHECK("auth_provider_credentials"."provider" in ('github', 'google', 'twitter', 'telegram', 'linkedin', 'turnstile'))
);
--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch() * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch() * 1000 as integer)) NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `identity_keys`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_sessions_token_unique` ON `auth_sessions` (`token`);--> statement-breakpoint
CREATE INDEX `auth_sessions_user_id_idx` ON `auth_sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `auth_settings` (
	`id` text PRIMARY KEY DEFAULT 'main' NOT NULL,
	`registration_mode` text DEFAULT 'invite_only' NOT NULL,
	`email_enabled` integer DEFAULT true NOT NULL,
	`github_enabled` integer DEFAULT false NOT NULL,
	`google_enabled` integer DEFAULT false NOT NULL,
	`linkedin_enabled` integer DEFAULT false NOT NULL,
	`twitter_enabled` integer DEFAULT false NOT NULL,
	`telegram_enabled` integer DEFAULT false NOT NULL,
	`turnstile_enabled` integer DEFAULT false NOT NULL,
	`email_from` text,
	`email_from_name` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "auth_settings_singleton_check" CHECK("auth_settings"."id" = 'main'),
	CONSTRAINT "auth_settings_registration_mode_check" CHECK("auth_settings"."registration_mode" in ('open', 'invite_only'))
);
--> statement-breakpoint
CREATE TABLE `auth_users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (cast(unixepoch() * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch() * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_users_email_unique` ON `auth_users` (`email`);--> statement-breakpoint
CREATE TABLE `auth_verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch() * 1000 as integer)),
	`updated_at` integer DEFAULT (cast(unixepoch() * 1000 as integer))
);
--> statement-breakpoint
CREATE TABLE `backup_destinations` (
	`id` text PRIMARY KEY DEFAULT 'main' NOT NULL,
	`endpoint` text NOT NULL,
	`region` text DEFAULT 'auto' NOT NULL,
	`bucket` text NOT NULL,
	`prefix` text DEFAULT 'llll' NOT NULL,
	`access_key_id` text NOT NULL,
	`secret_access_key_ciphertext` text NOT NULL,
	`secret_access_key_iv` text NOT NULL,
	`secret_access_key_version` integer DEFAULT 1 NOT NULL,
	`last_backup_key` text,
	`last_backup_at` text,
	`last_backup_size_bytes` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "backup_destinations_singleton_check" CHECK("backup_destinations"."id" = 'main')
);
--> statement-breakpoint
CREATE TABLE `canvas_edges` (
	`id` text PRIMARY KEY NOT NULL,
	`canvas_id` text NOT NULL,
	`from_node_id` text NOT NULL,
	`to_node_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`canvas_id`) REFERENCES `canvases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`from_node_id`) REFERENCES `canvas_nodes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_node_id`) REFERENCES `canvas_nodes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "canvas_edges_not_self_check" CHECK("canvas_edges"."from_node_id" <> "canvas_edges"."to_node_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `canvas_edges_nodes_unique` ON `canvas_edges` (`canvas_id`,`from_node_id`,`to_node_id`);--> statement-breakpoint
CREATE INDEX `canvas_edges_canvas_idx` ON `canvas_edges` (`canvas_id`,`created_at`);--> statement-breakpoint
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
	FOREIGN KEY (`canvas_id`) REFERENCES `canvases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "canvas_nodes_kind_check" CHECK("canvas_nodes"."kind" in ('note', 'text')),
	CONSTRAINT "canvas_nodes_color_check" CHECK("canvas_nodes"."color" in ('neutral', 'orange', 'blue', 'green', 'red')),
	CONSTRAINT "canvas_nodes_version_check" CHECK("canvas_nodes"."version" > 0)
);
--> statement-breakpoint
CREATE INDEX `canvas_nodes_canvas_idx` ON `canvas_nodes` (`canvas_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `canvases` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "canvases_version_check" CHECK("canvases"."version" > 0)
);
--> statement-breakpoint
CREATE INDEX `canvases_position_idx` ON `canvases` (`position`);--> statement-breakpoint
CREATE TABLE `channel_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `channel_categories_position_idx` ON `channel_categories` (`position`);--> statement-breakpoint
CREATE TABLE `channel_members` (
	`channel_id` text NOT NULL,
	`user_id` text NOT NULL,
	`hidden_at` text,
	`joined_at` text NOT NULL,
	PRIMARY KEY(`channel_id`, `user_id`),
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `channel_members_user_id_idx` ON `channel_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `channel_reads` (
	`channel_id` text NOT NULL,
	`user_id` text NOT NULL,
	`last_read_message_id` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`channel_id`, `user_id`),
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`last_read_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `channel_reads_user_id_idx` ON `channel_reads` (`user_id`);--> statement-breakpoint
CREATE TABLE `channel_role_overrides` (
	`channel_id` text NOT NULL,
	`role_id` text NOT NULL,
	`allow_mask` integer DEFAULT 0 NOT NULL,
	`deny_mask` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`channel_id`, `role_id`),
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "channel_role_overrides_allow_check" CHECK(("channel_role_overrides"."allow_mask" & ~112) = 0),
	CONSTRAINT "channel_role_overrides_deny_check" CHECK(("channel_role_overrides"."deny_mask" & ~112) = 0),
	CONSTRAINT "channel_role_overrides_disjoint_check" CHECK(("channel_role_overrides"."allow_mask" & "channel_role_overrides"."deny_mask") = 0)
);
--> statement-breakpoint
CREATE INDEX `channel_role_overrides_role_id_idx` ON `channel_role_overrides` (`role_id`);--> statement-breakpoint
CREATE TABLE `channels` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`topic` text DEFAULT '' NOT NULL,
	`type` text NOT NULL,
	`visibility` text DEFAULT 'workspace' NOT NULL,
	`category_id` text,
	`position` integer DEFAULT 0 NOT NULL,
	`huddle_meeting_id` text,
	`parent_id` text,
	`parent_message_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `channel_categories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`parent_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "channels_type_check" CHECK("channels"."type" in ('text', 'voice', 'thread', 'dm')),
	CONSTRAINT "channels_visibility_check" CHECK("channels"."visibility" in ('workspace', 'private')),
	CONSTRAINT "channels_dm_private_check" CHECK("channels"."type" <> 'dm' or "channels"."visibility" = 'private'),
	CONSTRAINT "channels_thread_parent_check" CHECK(
    ("channels"."type" = 'thread' and "channels"."parent_id" is not null and "channels"."parent_message_id" is not null)
    or ("channels"."type" <> 'thread' and "channels"."parent_id" is null and "channels"."parent_message_id" is null)
  )
);
--> statement-breakpoint
CREATE INDEX `channels_position_idx` ON `channels` (`position`);--> statement-breakpoint
CREATE INDEX `channels_type_idx` ON `channels` (`type`);--> statement-breakpoint
CREATE INDEX `channels_category_id_idx` ON `channels` (`category_id`);--> statement-breakpoint
CREATE INDEX `channels_parent_id_idx` ON `channels` (`parent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `channels_thread_root_unique` ON `channels` (`parent_message_id`) WHERE "channels"."type" = 'thread';--> statement-breakpoint
CREATE TABLE `data_bookmarks` (
	`user_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`user_id`, `target_type`, `target_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "data_bookmarks_target_type_check" CHECK("data_bookmarks"."target_type" in ('database_view', 'document', 'canvas'))
);
--> statement-breakpoint
CREATE INDEX `data_bookmarks_user_position_idx` ON `data_bookmarks` (`user_id`,`position`,`created_at`);--> statement-breakpoint
CREATE TABLE `database_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`archived_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `database_definitions_position_idx` ON `database_definitions` (`position`);--> statement-breakpoint
CREATE TABLE `database_fields` (
	`id` text PRIMARY KEY NOT NULL,
	`database_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`slot` text NOT NULL,
	`config_json` text DEFAULT '{}' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`database_id`) REFERENCES `database_definitions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "database_fields_type_check" CHECK("database_fields"."type" in ('text', 'number', 'boolean', 'date', 'select'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `database_fields_name_unique` ON `database_fields` (`database_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `database_fields_slot_unique` ON `database_fields` (`database_id`,`type`,`slot`);--> statement-breakpoint
CREATE INDEX `database_fields_position_idx` ON `database_fields` (`database_id`,`position`);--> statement-breakpoint
CREATE TABLE `database_items` (
	`id` text PRIMARY KEY NOT NULL,
	`database_id` text NOT NULL,
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
	FOREIGN KEY (`database_id`) REFERENCES `database_definitions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "database_items_version_check" CHECK("database_items"."version" > 0)
);
--> statement-breakpoint
CREATE INDEX `database_items_database_position_idx` ON `database_items` (`database_id`,`position`);--> statement-breakpoint
CREATE TABLE `database_views` (
	`id` text PRIMARY KEY NOT NULL,
	`database_id` text NOT NULL,
	`name` text NOT NULL,
	`layout` text DEFAULT 'table' NOT NULL,
	`config_json` text DEFAULT '{"visibleFieldIds":null,"filters":[],"sorts":[{"fieldId":"title","direction":"asc"}],"groupFieldId":null,"dateFieldId":null}' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`database_id`) REFERENCES `database_definitions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "database_views_layout_check" CHECK("database_views"."layout" in ('table', 'board', 'calendar', 'list')),
	CONSTRAINT "database_views_version_check" CHECK("database_views"."version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `database_views_name_unique` ON `database_views` (`database_id`,`name`);--> statement-breakpoint
CREATE INDEX `database_views_database_position_idx` ON `database_views` (`database_id`,`position`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "documents_version_check" CHECK("documents"."version" > 0)
);
--> statement-breakpoint
CREATE INDEX `documents_position_idx` ON `documents` (`position`);--> statement-breakpoint
CREATE TABLE `email_domains` (
	`id` text PRIMARY KEY DEFAULT 'main' NOT NULL,
	`zone_id` text NOT NULL,
	`domain` text NOT NULL,
	`app_hostname` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_domains_domain_unique` ON `email_domains` (`domain`);--> statement-breakpoint
CREATE TABLE `email_mailbox_access` (
	`channel_id` text NOT NULL,
	`user_id` text NOT NULL,
	`permission` text DEFAULT 'read' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`channel_id`, `user_id`),
	FOREIGN KEY (`channel_id`) REFERENCES `email_mailboxes`(`channel_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "email_mailbox_access_permission_check" CHECK("email_mailbox_access"."permission" in ('read', 'send', 'manage'))
);
--> statement-breakpoint
CREATE INDEX `email_mailbox_access_user_idx` ON `email_mailbox_access` (`user_id`);--> statement-breakpoint
CREATE TABLE `email_mailboxes` (
	`channel_id` text PRIMARY KEY NOT NULL,
	`domain_id` text NOT NULL,
	`local_part` text NOT NULL,
	`display_name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`domain_id`) REFERENCES `email_domains`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "email_mailboxes_local_part_check" CHECK("email_mailboxes"."local_part" = lower("email_mailboxes"."local_part") and length("email_mailboxes"."local_part") between 1 and 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_mailboxes_address_unique` ON `email_mailboxes` (`domain_id`,`local_part`);--> statement-breakpoint
CREATE TABLE `email_messages` (
	`message_id` text PRIMARY KEY NOT NULL,
	`thread_channel_id` text NOT NULL,
	`direction` text NOT NULL,
	`from_address` text NOT NULL,
	`from_name` text,
	`to_json` text DEFAULT '[]' NOT NULL,
	`cc_json` text DEFAULT '[]' NOT NULL,
	`bcc_json` text DEFAULT '[]' NOT NULL,
	`rfc_message_id` text,
	`in_reply_to` text,
	`references_json` text DEFAULT '[]' NOT NULL,
	`delivery_status` text DEFAULT 'received' NOT NULL,
	`raw_r2_key` text,
	`created_at` text NOT NULL,
	`mailbox_channel_id` text,
	`client_request_id` text,
	`delivery_attempts` integer DEFAULT 0 NOT NULL,
	`delivery_error` text,
	`delivered_at` text,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_channel_id`) REFERENCES `email_threads`(`channel_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_channel_id`) REFERENCES `email_mailboxes`(`channel_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "email_messages_direction_check" CHECK("email_messages"."direction" in ('inbound', 'outbound')),
	CONSTRAINT "email_messages_delivery_status_check" CHECK("email_messages"."delivery_status" in ('received', 'pending', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_messages_mailbox_rfc_message_id_unique` ON `email_messages` (`mailbox_channel_id`,`rfc_message_id`) WHERE "email_messages"."rfc_message_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `email_messages_mailbox_client_request_unique` ON `email_messages` (`mailbox_channel_id`,`client_request_id`) WHERE "email_messages"."client_request_id" is not null;--> statement-breakpoint
CREATE INDEX `email_messages_thread_created_idx` ON `email_messages` (`thread_channel_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `email_threads` (
	`channel_id` text PRIMARY KEY NOT NULL,
	`mailbox_channel_id` text NOT NULL,
	`subject` text NOT NULL,
	`status` text DEFAULT 'inbox' NOT NULL,
	`participants_json` text DEFAULT '[]' NOT NULL,
	`last_message_at` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_channel_id`) REFERENCES `email_mailboxes`(`channel_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "email_threads_status_check" CHECK("email_threads"."status" in ('inbox', 'archive', 'spam', 'trash'))
);
--> statement-breakpoint
CREATE INDEX `email_threads_mailbox_status_latest_idx` ON `email_threads` (`mailbox_channel_id`,`status`,`last_message_at`);--> statement-breakpoint
CREATE TABLE `gadget_draft_role_access` (
	`gadget_id` text NOT NULL,
	`role_id` text NOT NULL,
	PRIMARY KEY(`gadget_id`, `role_id`),
	FOREIGN KEY (`gadget_id`) REFERENCES `gadgets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `gadget_draft_role_access_role_idx` ON `gadget_draft_role_access` (`role_id`,`gadget_id`);--> statement-breakpoint
CREATE TABLE `gadget_version_role_access` (
	`gadget_version_id` text NOT NULL,
	`role_id` text NOT NULL,
	PRIMARY KEY(`gadget_version_id`, `role_id`),
	FOREIGN KEY (`gadget_version_id`) REFERENCES `gadget_versions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `gadget_version_role_access_role_idx` ON `gadget_version_role_access` (`role_id`,`gadget_version_id`);--> statement-breakpoint
CREATE TABLE `gadget_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`gadget_id` text NOT NULL,
	`version` integer NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`spec_json` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`gadget_id`) REFERENCES `gadgets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "gadget_versions_version_check" CHECK("gadget_versions"."version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gadget_versions_number_unique` ON `gadget_versions` (`gadget_id`,`version`);--> statement-breakpoint
CREATE TABLE `gadgets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`draft_spec_json` text NOT NULL,
	`draft_revision` integer DEFAULT 1 NOT NULL,
	`published_version` integer,
	`position` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "gadgets_draft_revision_check" CHECK("gadgets"."draft_revision" > 0),
	CONSTRAINT "gadgets_published_version_check" CHECK("gadgets"."published_version" is null or "gadgets"."published_version" > 0)
);
--> statement-breakpoint
CREATE INDEX `gadgets_position_idx` ON `gadgets` (`position`,`created_at`);--> statement-breakpoint
CREATE TABLE `identity_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (cast(unixepoch() * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch() * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `invites` (
	`code` text PRIMARY KEY NOT NULL,
	`creator_id` text NOT NULL,
	`max_uses` integer DEFAULT 0 NOT NULL,
	`uses` integer DEFAULT 0 NOT NULL,
	`expires_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`creator_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `invites_creator_id_idx` ON `invites` (`creator_id`);--> statement-breakpoint
CREATE INDEX `invites_expires_at_idx` ON `invites` (`expires_at`);--> statement-breakpoint
CREATE TABLE `mcp_access_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`token_prefix` text NOT NULL,
	`scopes_json` text NOT NULL,
	`subject_id` text NOT NULL,
	`created_by` text NOT NULL,
	`last_used_at` text,
	`revoked_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`subject_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_access_tokens_hash_unique` ON `mcp_access_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `mcp_access_tokens_subject_id_idx` ON `mcp_access_tokens` (`subject_id`);--> statement-breakpoint
CREATE INDEX `mcp_access_tokens_created_by_idx` ON `mcp_access_tokens` (`created_by`);--> statement-breakpoint
CREATE INDEX `mcp_access_tokens_active_idx` ON `mcp_access_tokens` (`revoked_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `message_mentions` (
	`message_id` text NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`message_id`, `user_id`),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `message_mentions_user_id_idx` ON `message_mentions` (`user_id`);--> statement-breakpoint
CREATE TABLE `message_pins` (
	`message_id` text PRIMARY KEY NOT NULL,
	`pinned_by` text NOT NULL,
	`pinned_at` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pinned_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `message_pins_pinned_by_idx` ON `message_pins` (`pinned_by`);--> statement-breakpoint
CREATE INDEX `message_pins_pinned_at_idx` ON `message_pins` (`pinned_at`);--> statement-breakpoint
CREATE TABLE `message_reactions` (
	`message_id` text NOT NULL,
	`user_id` text NOT NULL,
	`emoji` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`message_id`, `user_id`, `emoji`),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `message_reactions_user_id_idx` ON `message_reactions` (`user_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`author_id` text NOT NULL,
	`content` text NOT NULL,
	`reply_to_id` text,
	`edited_at` text,
	`deleted_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reply_to_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `messages_channel_created_idx` ON `messages` (`channel_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `messages_author_id_idx` ON `messages` (`author_id`);--> statement-breakpoint
CREATE TABLE `notification_outbox` (
	`event_id` text NOT NULL,
	`subscription_id` text NOT NULL,
	`recipient_id` text NOT NULL,
	`kind` text NOT NULL,
	`channel_id` text NOT NULL,
	`payload_json` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`available_at` text NOT NULL,
	`lease_token` text,
	`lease_until` text,
	`delivered_at` text,
	`failed_at` text,
	`last_error` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`event_id`, `subscription_id`),
	FOREIGN KEY (`subscription_id`) REFERENCES `push_subscriptions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recipient_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "notification_outbox_kind_check" CHECK("notification_outbox"."kind" in ('mention', 'dm_message', 'huddle_started'))
);
--> statement-breakpoint
CREATE INDEX `notification_outbox_due_idx` ON `notification_outbox` (`available_at`) WHERE "notification_outbox"."delivered_at" is null and "notification_outbox"."failed_at" is null;--> statement-breakpoint
CREATE TABLE `onboarding_acceptances` (
	`user_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`accepted_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `revision_id`),
	FOREIGN KEY (`user_id`) REFERENCES `identity_keys`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`revision_id`) REFERENCES `onboarding_revisions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `onboarding_acceptances_revision_idx` ON `onboarding_acceptances` (`revision_id`);--> statement-breakpoint
CREATE TABLE `onboarding_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`privacy_json` text NOT NULL,
	`terms_json` text NOT NULL,
	`rules_json` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `identity_keys`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `onboarding_revisions_version_unique` ON `onboarding_revisions` (`version`);--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`user_agent` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE INDEX `push_subscriptions_user_id_idx` ON `push_subscriptions` (`user_id`);--> statement-breakpoint
CREATE TABLE `realtimekit_settings` (
	`id` text PRIMARY KEY DEFAULT 'main' NOT NULL,
	`account_id` text NOT NULL,
	`app_id` text NOT NULL,
	`api_token_ciphertext` text NOT NULL,
	`api_token_iv` text NOT NULL,
	`api_token_version` integer DEFAULT 1 NOT NULL,
	`host_preset` text NOT NULL,
	`participant_preset` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "realtimekit_settings_singleton_check" CHECK("realtimekit_settings"."id" = 'main')
);
--> statement-breakpoint
CREATE TABLE `roles` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`permissions_bitmask` integer NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`is_system` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `roles_key_unique` ON `roles` (`key`);--> statement-breakpoint
CREATE TABLE `scheduled_huddles` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`starts_at` text NOT NULL,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`created_by` text NOT NULL,
	`meeting_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "scheduled_huddles_status_check" CHECK("scheduled_huddles"."status" in ('scheduled', 'ready', 'started', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX `scheduled_huddles_channel_start_idx` ON `scheduled_huddles` (`channel_id`,`starts_at`);--> statement-breakpoint
CREATE INDEX `scheduled_huddles_status_start_idx` ON `scheduled_huddles` (`status`,`starts_at`);--> statement-breakpoint
CREATE TABLE `task_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`uploader_id` text NOT NULL,
	`r2_key` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`width` integer,
	`height` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`uploader_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "task_attachments_size_check" CHECK("task_attachments"."size_bytes" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_attachments_r2_key_unique` ON `task_attachments` (`r2_key`);--> statement-breakpoint
CREATE INDEX `task_attachments_task_created_idx` ON `task_attachments` (`task_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `task_boards` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`archived_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `task_boards_position_idx` ON `task_boards` (`position`);--> statement-breakpoint
CREATE TABLE `task_checklist_items` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`title` text NOT NULL,
	`completed` integer DEFAULT false NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `task_checklist_items_task_position_idx` ON `task_checklist_items` (`task_id`,`position`);--> statement-breakpoint
CREATE TABLE `task_dependencies` (
	`task_id` text NOT NULL,
	`depends_on_task_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`task_id`, `depends_on_task_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`depends_on_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "task_dependencies_not_self_check" CHECK("task_dependencies"."task_id" <> "task_dependencies"."depends_on_task_id")
);
--> statement-breakpoint
CREATE INDEX `task_dependencies_depends_on_idx` ON `task_dependencies` (`depends_on_task_id`);--> statement-breakpoint
CREATE TABLE `task_label_links` (
	`task_id` text NOT NULL,
	`label_id` text NOT NULL,
	PRIMARY KEY(`task_id`, `label_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`label_id`) REFERENCES `task_labels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `task_label_links_label_idx` ON `task_label_links` (`label_id`);--> statement-breakpoint
CREATE TABLE `task_labels` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT 'neutral' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `task_boards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_labels_board_name_unique` ON `task_labels` (`board_id`,`name`);--> statement-breakpoint
CREATE INDEX `task_labels_board_position_idx` ON `task_labels` (`board_id`,`position`);--> statement-breakpoint
CREATE TABLE `task_number_sequence` (
	`id` integer PRIMARY KEY NOT NULL,
	`next_number` integer NOT NULL,
	CONSTRAINT "task_number_sequence_singleton_check" CHECK("task_number_sequence"."id" = 1),
	CONSTRAINT "task_number_sequence_next_check" CHECK("task_number_sequence"."next_number" > 0)
);
--> statement-breakpoint
CREATE TABLE `task_numbers` (
	`task_id` text PRIMARY KEY NOT NULL,
	`number` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_numbers_number_unique` ON `task_numbers` (`number`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'backlog' NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`due_at` text,
	`position` integer DEFAULT 0 NOT NULL,
	`assignee_id` text,
	`assignee_user_id` text,
	`channel_id` text,
	`discussion_channel_id` text,
	`created_by` text NOT NULL,
	`result_summary` text,
	`result_details` text,
	`last_error` text,
	`archived_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `task_boards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assignee_id`) REFERENCES `agents`(`user_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`assignee_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`discussion_channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tasks_status_check" CHECK("tasks"."status" in ('backlog', 'ready', 'review', 'done', 'failed')),
	CONSTRAINT "tasks_priority_check" CHECK("tasks"."priority" in ('low', 'normal', 'high', 'urgent'))
);
--> statement-breakpoint
CREATE INDEX `tasks_board_status_position_idx` ON `tasks` (`board_id`,`status`,`position`);--> statement-breakpoint
CREATE INDEX `tasks_assignee_id_idx` ON `tasks` (`assignee_id`);--> statement-breakpoint
CREATE INDEX `tasks_assignee_user_id_idx` ON `tasks` (`assignee_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_discussion_channel_unique` ON `tasks` (`discussion_channel_id`) WHERE "tasks"."discussion_channel_id" is not null;--> statement-breakpoint
CREATE TABLE `telemetry_settings` (
	`id` text PRIMARY KEY DEFAULT 'main' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "telemetry_settings_singleton_check" CHECK("telemetry_settings"."id" = 'main')
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'human' NOT NULL,
	`handle` text,
	`display_name` text NOT NULL,
	`avatar_r2_key` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`role_id` text,
	`nickname` text,
	`joined_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`id`) REFERENCES `identity_keys`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "users_kind_check" CHECK("users"."kind" in ('human', 'agent')),
	CONSTRAINT "users_status_check" CHECK("users"."status" in ('pending', 'active', 'removed')),
	CONSTRAINT "users_active_role_check" CHECK("users"."status" <> 'active' or ("users"."role_id" is not null and "users"."joined_at" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_handle_unique` ON `users` (`handle`);--> statement-breakpoint
CREATE INDEX `users_status_idx` ON `users` (`status`);--> statement-breakpoint
CREATE INDEX `users_kind_idx` ON `users` (`kind`);--> statement-breakpoint
CREATE INDEX `users_role_id_idx` ON `users` (`role_id`);--> statement-breakpoint
CREATE TABLE `workspace` (
	`id` text PRIMARY KEY DEFAULT 'main' NOT NULL,
	`name` text NOT NULL,
	`icon_r2_key` text,
	`owner_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "workspace_singleton_check" CHECK("workspace"."id" = 'main')
);

--> statement-breakpoint
CREATE VIRTUAL TABLE `message_search` USING fts5(
	`message_id` UNINDEXED,
	`content`,
	tokenize = 'unicode61 remove_diacritics 2'
);

--> statement-breakpoint
CREATE TRIGGER `auth_users_identity_key_delete` AFTER DELETE ON `auth_users`
BEGIN
  DELETE FROM `identity_keys` WHERE `id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `auth_users_identity_key_insert` AFTER INSERT ON `auth_users`
BEGIN
  INSERT OR IGNORE INTO `identity_keys` (`id`, `name`, `email`, `email_verified`, `image`, `created_at`, `updated_at`)
  VALUES (NEW.`id`, NEW.`name`, NEW.`email`, NEW.`email_verified`, NEW.`image`, NEW.`created_at`, NEW.`updated_at`);
END;
--> statement-breakpoint
CREATE TRIGGER `auth_users_identity_key_update` AFTER UPDATE ON `auth_users`
BEGIN
  UPDATE `identity_keys`
  SET `name` = NEW.`name`, `email` = NEW.`email`, `email_verified` = NEW.`email_verified`, `image` = NEW.`image`, `updated_at` = NEW.`updated_at`
  WHERE `id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `canvas_bookmarks_after_delete` AFTER DELETE ON `canvases` BEGIN
  DELETE FROM `data_bookmarks` WHERE `target_type` = 'canvas' AND `target_id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `database_default_view_after_insert` AFTER INSERT ON `database_definitions` BEGIN
  INSERT INTO `database_views` (`id`, `database_id`, `name`, `layout`, `position`, `created_by`, `created_at`, `updated_at`)
  VALUES ('default:' || NEW.`id`, NEW.`id`, 'All records', 'table', 1024, NEW.`created_by`, NEW.`created_at`, NEW.`updated_at`);
END;
--> statement-breakpoint
CREATE TRIGGER `database_view_bookmarks_after_delete` AFTER DELETE ON `database_views` BEGIN
  DELETE FROM `data_bookmarks` WHERE `target_type` = 'database_view' AND `target_id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `document_bookmarks_after_delete` AFTER DELETE ON `documents` BEGIN
  DELETE FROM `data_bookmarks` WHERE `target_type` = 'document' AND `target_id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `message_search_after_delete`
AFTER DELETE ON `messages`
BEGIN
	DELETE FROM `message_search` WHERE `message_id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `message_search_after_insert`
AFTER INSERT ON `messages`
WHEN NEW.`deleted_at` IS NULL AND length(trim(NEW.`content`)) > 0
BEGIN
	INSERT INTO `message_search` (`message_id`, `content`)
	VALUES (NEW.`id`, NEW.`content`);
END;
--> statement-breakpoint
CREATE TRIGGER `message_search_after_update`
AFTER UPDATE OF `content`, `deleted_at` ON `messages`
BEGIN
	DELETE FROM `message_search` WHERE `message_id` = OLD.`id`;
	INSERT INTO `message_search` (`message_id`, `content`)
	SELECT NEW.`id`, NEW.`content`
	WHERE NEW.`deleted_at` IS NULL AND length(trim(NEW.`content`)) > 0;
END;
--> statement-breakpoint
CREATE TRIGGER `tasks_assign_number_after_insert`
AFTER INSERT ON `tasks`
WHEN NOT EXISTS (SELECT 1 FROM `task_numbers` WHERE `task_id` = NEW.`id`)
BEGIN
	INSERT INTO `task_numbers` (`task_id`, `number`)
	SELECT NEW.`id`, `next_number` FROM `task_number_sequence` WHERE `id` = 1;
	UPDATE `task_number_sequence` SET `next_number` = `next_number` + 1 WHERE `id` = 1;
END;
--> statement-breakpoint
INSERT INTO task_number_sequence (id, next_number) VALUES (1, 1001);
