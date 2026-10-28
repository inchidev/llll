-- server-v2 baseline: the complete Server schema for a fresh database.
-- Squashed on 2026-10-28 from the server-v1 chain 0000-0032, which stays in Git history.
-- Earlier databases cannot be upgraded into this lineage. Append new migrations after this file.
CREATE TABLE `account_recovery` (
	`user_id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
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
CREATE TABLE `agents` (
	`user_id` text PRIMARY KEY NOT NULL,
	`model` text DEFAULT '@cf/moonshotai/kimi-k2.7-code' NOT NULL,
	`instructions` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by` text NOT NULL,
	`last_active_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL, harness TEXT NOT NULL DEFAULT 'think' CHECK(harness IN ('think','pi')), `archived_at` text, `archived_by` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agents_status_check" CHECK("agents"."status" in ('active', 'paused'))
);
--> statement-breakpoint
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
CREATE TABLE `auth_accounts` (
	`id` text PRIMARY KEY NOT NULL,
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
	FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
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
	FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `auth_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
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
	CONSTRAINT "auth_settings_singleton_check" CHECK("auth_settings"."id" = 1),
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
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
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
	CONSTRAINT "backup_destinations_singleton_check" CHECK("backup_destinations"."id" = 1)
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
CREATE TABLE `channel_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE `channels` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`topic` text DEFAULT '' NOT NULL,
	`type` text NOT NULL,
	`visibility` text DEFAULT 'server' NOT NULL,
	`category_id` text,
	`position` integer DEFAULT 0 NOT NULL,
	`live_meeting_id` text,
	`parent_id` text,
	`parent_message_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL, dm_kind TEXT NOT NULL DEFAULT 'pair' CHECK (dm_kind IN ('pair', 'group')), dm_owner_id TEXT REFERENCES users(id) ON DELETE SET NULL, created_by TEXT REFERENCES users(id) ON DELETE SET NULL, dm_pair_key TEXT, `archived_at` text, `archived_by` text REFERENCES `users`(`id`) ON DELETE SET NULL,
	FOREIGN KEY (`category_id`) REFERENCES `channel_categories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`parent_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "channels_type_check" CHECK("channels"."type" in ('text', 'thread', 'dm')),
	CONSTRAINT "channels_visibility_check" CHECK("channels"."visibility" in ('server', 'private')),
	CONSTRAINT "channels_dm_private_check" CHECK("channels"."type" <> 'dm' or "channels"."visibility" = 'private'),
	CONSTRAINT "channels_thread_parent_check" CHECK(
    ("channels"."type" = 'thread' and "channels"."parent_id" is not null and "channels"."parent_message_id" is not null)
    or ("channels"."type" <> 'thread' and "channels"."parent_id" is null and "channels"."parent_message_id" is null)
  )
);
--> statement-breakpoint
CREATE TABLE `connection_grants` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`challenge` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `auth_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
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
CREATE TABLE `email_domains` (
	`id` text PRIMARY KEY NOT NULL,
	`zone_id` text NOT NULL,
	`domain` text NOT NULL,
	`app_hostname` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
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
	`delivered_at` text, provider_message_id TEXT, delivery_started_at TEXT, reply_to_json TEXT NOT NULL DEFAULT '[]',
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_channel_id`) REFERENCES `email_threads`(`channel_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_channel_id`) REFERENCES `email_mailboxes`(`channel_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "email_messages_direction_check" CHECK("email_messages"."direction" in ('inbound', 'outbound')),
	CONSTRAINT "email_messages_delivery_status_check" CHECK("email_messages"."delivery_status" in ('received', 'pending', 'sent', 'failed'))
);
--> statement-breakpoint
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
CREATE TABLE `gadget_draft_role_access` (
	`gadget_id` text NOT NULL,
	`role_id` text NOT NULL,
	PRIMARY KEY(`gadget_id`, `role_id`),
	FOREIGN KEY (`gadget_id`) REFERENCES `gadgets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `gadget_version_role_access` (
	`gadget_version_id` text NOT NULL,
	`role_id` text NOT NULL,
	PRIMARY KEY(`gadget_version_id`, `role_id`),
	FOREIGN KEY (`gadget_version_id`) REFERENCES `gadget_versions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
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
CREATE TABLE `message_mentions` (
	`message_id` text NOT NULL,
	`user_id` text NOT NULL, `role_id` text,
	PRIMARY KEY(`message_id`, `user_id`),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `message_pins` (
	`message_id` text PRIMARY KEY NOT NULL,
	`pinned_by` text NOT NULL,
	`pinned_at` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pinned_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
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
CREATE TABLE `onboarding_acceptances` (
	`user_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`accepted_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `revision_id`),
	FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`revision_id`) REFERENCES `onboarding_revisions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `onboarding_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`privacy_json` text NOT NULL,
	`terms_json` text NOT NULL,
	`rules_json` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
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
CREATE TABLE `realtimekit_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`account_id` text NOT NULL,
	`app_id` text NOT NULL,
	`api_token_ciphertext` text NOT NULL,
	`api_token_iv` text NOT NULL,
	`api_token_version` integer DEFAULT 1 NOT NULL,
	`host_preset` text NOT NULL,
	`participant_preset` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "realtimekit_settings_singleton_check" CHECK("realtimekit_settings"."id" = 1)
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
, resource_access_json TEXT NOT NULL DEFAULT '{}', `mentionable` integer DEFAULT false NOT NULL);
--> statement-breakpoint
CREATE TABLE `server` (
	`id` text PRIMARY KEY NOT NULL,
	`singleton` integer DEFAULT 1 NOT NULL,
	`name` text NOT NULL,
	`icon_r2_key` text,
	`owner_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`id`) REFERENCES `server_identity`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "server_singleton_check" CHECK("server"."singleton" = 1)
);
--> statement-breakpoint
CREATE TABLE `server_identity` (
	`singleton` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	CONSTRAINT "server_identity_singleton_check" CHECK("server_identity"."singleton" = 1),
	CONSTRAINT "server_identity_uuid_check" CHECK(length("server_identity"."id") = 36 AND substr("server_identity"."id",15,1) = '4' AND substr("server_identity"."id",20,1) IN ('8','9','a','b'))
);
--> statement-breakpoint
CREATE TABLE `server_schema` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`version` text NOT NULL,
	CONSTRAINT "server_schema_id_check" CHECK("server_schema"."id" = 1),
	CONSTRAINT "server_schema_version_check" CHECK("server_schema"."version" = 'server-v2')
);
--> statement-breakpoint
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
CREATE TABLE `task_label_links` (
	`task_id` text NOT NULL,
	`label_id` text NOT NULL,
	PRIMARY KEY(`task_id`, `label_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`label_id`) REFERENCES `task_labels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
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
	`channel_id` text,
	`discussion_channel_id` text,
	`created_by` text NOT NULL,
	`result_summary` text,
	`result_details` text,
	`last_error` text,
	`archived_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL, environment_id TEXT REFERENCES agent_environments(id), project_id TEXT REFERENCES projects(id), factory_state TEXT, `source_channel_id` text, `source_message_id` text,
	FOREIGN KEY (`board_id`) REFERENCES `task_boards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assignee_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`discussion_channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tasks_status_check" CHECK("tasks"."status" in ('backlog', 'ready', 'review', 'done', 'failed')),
	CONSTRAINT "tasks_priority_check" CHECK("tasks"."priority" in ('low', 'normal', 'high', 'urgent'))
);
--> statement-breakpoint
CREATE TABLE `telemetry_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "telemetry_settings_singleton_check" CHECK("telemetry_settings"."id" = 1)
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
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "users_kind_check" CHECK("users"."kind" in ('human', 'agent')),
	CONSTRAINT "users_status_check" CHECK("users"."status" in ('pending', 'active', 'removed')),
	CONSTRAINT "users_active_role_check" CHECK("users"."status" <> 'active' or ("users"."role_id" is not null and "users"."joined_at" is not null))
);
--> statement-breakpoint
CREATE VIRTUAL TABLE `message_search` USING fts5(
	`message_id` UNINDEXED,
	`content`,
	tokenize = 'unicode61 remove_diacritics 2'
);
--> statement-breakpoint
CREATE TABLE `server_update_control` (
  `id` integer PRIMARY KEY NOT NULL,
  `revision` integer NOT NULL,
  `payload` text NOT NULL,
  CONSTRAINT `server_update_control_singleton` CHECK (`id` = 1)
);
--> statement-breakpoint
CREATE TABLE `mcp_oauth_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`subject_id` text NOT NULL,
	`created_by` text NOT NULL,
	`resource` text NOT NULL,
	`scopes_json` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text,
	`revoked_at` text,
	FOREIGN KEY (`client_id`) REFERENCES `auth_oauth_client`(`client_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`subject_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `auth_oauth_access_token` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`client_id` text NOT NULL,
	`session_id` text,
	`user_id` text,
	`reference_id` text,
	`authorization_code_id` text,
	`resources` text,
	`requested_user_info_claims` text,
	`refresh_id` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`revoked` integer,
	`confirmation` text,
	`scopes` text NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `auth_oauth_client`(`client_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `auth_sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`refresh_id`) REFERENCES `auth_oauth_refresh_token`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `auth_oauth_client` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`client_secret` text,
	`client_discovery_id` text,
	`disabled` integer DEFAULT false,
	`skip_consent` integer,
	`enable_end_session` integer,
	`subject_type` text,
	`scopes` text,
	`client_credentials_scopes` text DEFAULT '[]',
	`user_id` text,
	`created_at` integer,
	`updated_at` integer,
	`name` text,
	`uri` text,
	`icon` text,
	`contacts` text,
	`tos` text,
	`policy` text,
	`software_id` text,
	`software_version` text,
	`software_statement` text,
	`redirect_uris` text NOT NULL,
	`post_logout_redirect_uris` text,
	`backchannel_logout_uri` text,
	`backchannel_logout_session_required` integer,
	`token_endpoint_auth_method` text,
	`application_type` text,
	`jwks` text,
	`jwks_uri` text,
	`grant_types` text,
	`response_types` text,
	`require_p_k_c_e` integer,
	`dpop_bound_access_tokens` integer DEFAULT false,
	`reference_id` text,
	`metadata` text,
	FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `auth_oauth_client_assertion` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `auth_oauth_client_resource` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`metadata` text,
	`created_at` integer,
	FOREIGN KEY (`client_id`) REFERENCES `auth_oauth_client`(`client_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resource_id`) REFERENCES `auth_oauth_resource`(`identifier`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `auth_oauth_consent` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text,
	`reference_id` text,
	`resources` text,
	`requested_user_info_claims` text,
	`scopes` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `auth_oauth_client`(`client_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `auth_oauth_refresh_token` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`client_id` text NOT NULL,
	`session_id` text,
	`user_id` text NOT NULL,
	`reference_id` text,
	`authorization_code_id` text,
	`resources` text,
	`requested_user_info_claims` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`revoked` integer,
	`rotated_at` integer,
	`rotation_replay_response` text,
	`rotation_replay_expires_at` integer,
	`auth_time` integer,
	`confirmation` text,
	`scopes` text NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `auth_oauth_client`(`client_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `auth_sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `auth_oauth_resource` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`name` text NOT NULL,
	`access_token_ttl` integer,
	`refresh_token_ttl` integer,
	`signing_algorithm` text,
	`signing_key_id` text,
	`allowed_scopes` text,
	`custom_claims` text,
	`dpop_bound_access_tokens_required` integer DEFAULT false,
	`disabled` integer DEFAULT false,
	`created_at` integer,
	`updated_at` integer,
	`policy_version` integer DEFAULT 1,
	`metadata` text
);
--> statement-breakpoint
CREATE TABLE agent_sessions (
 id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(user_id), channel_id TEXT NOT NULL REFERENCES channels(id),
 active_run_id TEXT, transcript_key TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, untrusted_at TEXT,
 UNIQUE(agent_id,channel_id)
);
--> statement-breakpoint
CREATE TABLE agent_runs (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES agent_sessions(id), agent_id TEXT NOT NULL REFERENCES agents(user_id),
 channel_id TEXT NOT NULL REFERENCES channels(id), initiated_by TEXT NOT NULL REFERENCES users(id), task_id TEXT REFERENCES tasks(id),
 source_message_id TEXT REFERENCES messages(id), idempotency_key TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')),
 prompt TEXT NOT NULL, model TEXT NOT NULL, instructions TEXT NOT NULL, mandate_json TEXT NOT NULL,
 result_text TEXT, result_message_id TEXT, last_error TEXT, model_calls INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0,
 event_cursor INTEGER NOT NULL DEFAULT 0, deadline TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, environment_json TEXT, files_key TEXT, task_edit_at TEXT,
 UNIQUE(agent_id,initiated_by,idempotency_key)
);
--> statement-breakpoint
CREATE TABLE agent_run_events (
 run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE, sequence INTEGER NOT NULL,
 event_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(run_id,sequence)
);
--> statement-breakpoint
CREATE TABLE agent_run_tools (
 run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE, call_id TEXT NOT NULL, name TEXT NOT NULL,
 arguments_json TEXT NOT NULL, policy_json TEXT NOT NULL DEFAULT '', status TEXT NOT NULL CHECK(status IN ('pending','completed','failed')),
 result_json TEXT, created_at TEXT NOT NULL, PRIMARY KEY(run_id,call_id)
);
--> statement-breakpoint
CREATE TABLE agent_schedules (
 id TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES users(id), created_by TEXT NOT NULL REFERENCES users(id),
 channel_id TEXT NOT NULL REFERENCES channels(id), kind TEXT NOT NULL CHECK(kind IN ('reminder','work')), content TEXT NOT NULL,
 agent_id TEXT REFERENCES agents(user_id), task_id TEXT REFERENCES tasks(id), first_at TEXT NOT NULL, timezone TEXT NOT NULL,
 recurrence TEXT NOT NULL CHECK(recurrence IN ('once','daily','weekly')), next_at TEXT,
 status TEXT NOT NULL CHECK(status IN ('active','completed','cancelled','blocked')), last_error TEXT,
 authorization_json TEXT NOT NULL, mandate_json TEXT, created_at TEXT NOT NULL
, paused_at TEXT, dismissed_at TEXT, last_error_code TEXT);
--> statement-breakpoint
CREATE TABLE agent_schedule_occurrences (
 schedule_id TEXT NOT NULL REFERENCES agent_schedules(id), due_at TEXT NOT NULL, message_id TEXT NOT NULL,
 run_id TEXT REFERENCES agent_runs(id), completed_at TEXT, attempts INTEGER NOT NULL DEFAULT 0, failed_at TEXT, last_error TEXT, PRIMARY KEY(schedule_id,due_at)
);
--> statement-breakpoint
CREATE TABLE agent_environments (
 id TEXT PRIMARY KEY, config_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1,
 created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE agent_code_proposals (
 run_id TEXT PRIMARY KEY REFERENCES agent_runs(id), environment_id TEXT NOT NULL REFERENCES agent_environments(id),
 input_hash TEXT NOT NULL, branch TEXT NOT NULL, commit_sha TEXT, published_commit_sha TEXT, pull_number INTEGER,
 lease_until TEXT, lease_token TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE server_domains (
  origin TEXT PRIMARY KEY NOT NULL,
  hostname TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  CONSTRAINT server_domains_primary_check CHECK (is_primary IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE server_domain_requests (
  id TEXT PRIMARY KEY NOT NULL,
  action TEXT NOT NULL,
  hostname TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CONSTRAINT server_domain_requests_action_check CHECK (action IN ('add', 'remove', 'primary')),
  CONSTRAINT server_domain_requests_status_check CHECK (status IN ('pending', 'running', 'complete', 'failed'))
);
--> statement-breakpoint
CREATE TABLE server_settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE server_setup (
  singleton INTEGER PRIMARY KEY NOT NULL,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  server_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CONSTRAINT server_setup_singleton_check CHECK (singleton = 1)
);
--> statement-breakpoint
CREATE TABLE file_objects (key TEXT PRIMARY KEY, storage_key TEXT NOT NULL UNIQUE, size INTEGER NOT NULL CHECK(size >= 0), etag TEXT NOT NULL, uploaded_at TEXT NOT NULL, metadata TEXT NOT NULL, copied INTEGER NOT NULL DEFAULT 0 CHECK(copied IN (0,1)));
--> statement-breakpoint
CREATE TABLE file_uploads (id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, size INTEGER NOT NULL CHECK(size >= 0), created_at TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE agent_model_calls (run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE, call_number INTEGER NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT, total_tokens INTEGER, error TEXT, PRIMARY KEY(run_id,call_number));
--> statement-breakpoint
CREATE TABLE agent_run_deliveries (
  run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  task_status TEXT NOT NULL DEFAULT 'pending',
  task_error TEXT,
  report_status TEXT NOT NULL DEFAULT 'pending',
  report_error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE file_deletions (key TEXT PRIMARY KEY NOT NULL, scope_id TEXT NOT NULL, created_at TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE mcp_outbound_connections (
  id TEXT PRIMARY KEY NOT NULL,
  server_id TEXT NOT NULL REFERENCES server(id) ON DELETE CASCADE,
  owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 1,
  grants_json TEXT NOT NULL,
  tool_names_json TEXT NOT NULL,
  tools_json TEXT NOT NULL DEFAULT '[]',
  credential_json TEXT,
  credential_expires_at TEXT,
  checked_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
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
--> statement-breakpoint
CREATE TABLE agent_run_publications (
 id TEXT PRIMARY KEY,
 run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
 digest TEXT NOT NULL,
 payload_json TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','rejected','expired','executing','completed','uncertain')),
 message_id TEXT NOT NULL UNIQUE,
 created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 decided_at TEXT,
 decided_by TEXT REFERENCES users(id),
 completed_at TEXT
);
--> statement-breakpoint
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
CREATE TABLE git_connections (
 id TEXT PRIMARY KEY,
 name TEXT NOT NULL,
 provider TEXT NOT NULL,
 host TEXT NOT NULL,
 account TEXT NOT NULL,
 app_id TEXT NOT NULL,
 app_slug TEXT NOT NULL,
 credential_json TEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 1,
 created_by TEXT NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE git_setup_requests (
 state_hash TEXT PRIMARY KEY,
 name TEXT NOT NULL,
 account TEXT NOT NULL,
 actor_id TEXT NOT NULL REFERENCES users(id),
 origin TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','exchanging','complete','failed')),
 created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE compute_nodes (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
 capabilities_json TEXT NOT NULL DEFAULT '{}', last_seen TEXT, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE compute_pairings (
 token_hash TEXT PRIMARY KEY, name TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE factory_workspaces (
 id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES channels(id), task_id TEXT NOT NULL REFERENCES tasks(id), agent_id TEXT NOT NULL REFERENCES agents(user_id),
 initiated_by TEXT NOT NULL REFERENCES users(id), node_id TEXT NOT NULL REFERENCES compute_nodes(id),
 environment_json TEXT NOT NULL, origin_run_id TEXT NOT NULL REFERENCES agent_runs(id),
 status TEXT NOT NULL DEFAULT 'new', snapshot_json TEXT, pull_json TEXT, commands INTEGER NOT NULL DEFAULT 0,
 runtime_ms INTEGER NOT NULL DEFAULT 0, publication_count INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(task_id,agent_id,initiated_by)
);
--> statement-breakpoint
CREATE TABLE factory_actions (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES factory_workspaces(id), run_id TEXT NOT NULL REFERENCES agent_runs(id),
 call_id TEXT NOT NULL, digest TEXT NOT NULL, request_json TEXT NOT NULL, policy_json TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','approved','claimed','executing','completed','rejected','expired','cancelled','uncertain','failed')),
 expires_at TEXT NOT NULL, created_at TEXT NOT NULL, decided_by TEXT REFERENCES users(id), decided_at TEXT,
 lease_token TEXT, lease_until TEXT, result_json TEXT, completed_at TEXT, UNIQUE(run_id,call_id)
);
--> statement-breakpoint
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
CREATE TABLE role_policies (role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE, policy_id TEXT NOT NULL REFERENCES project_policies(id) ON DELETE CASCADE, PRIMARY KEY(role_id, policy_id));
--> statement-breakpoint
CREATE TABLE "notification_outbox" (
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
	CONSTRAINT "notification_outbox_kind_check" CHECK("kind" in ('mention', 'dm_message', 'live_started', 'mail'))
);
--> statement-breakpoint
INSERT INTO `server_schema` (`id`, `version`) VALUES (1, 'server-v2');
--> statement-breakpoint
INSERT INTO `task_number_sequence` (`id`, `next_number`) VALUES (1, 1001);
--> statement-breakpoint
INSERT INTO `project_policies` (`id`, `name`, `description`, `permissions_bitmask`, `version`, `created_by`, `created_at`, `updated_at`) VALUES ('project-policy-developer', 'Developer', 'Work on assigned project tasks and propose code changes.', 94085120, 1, NULL, '2026-10-28T13:21:58.351Z', '2026-10-28T13:21:58.351Z');
--> statement-breakpoint
INSERT INTO `project_policies` (`id`, `name`, `description`, `permissions_bitmask`, `version`, `created_by`, `created_at`, `updated_at`) VALUES ('project-policy-reviewer', 'Reviewer', 'Read project tasks and inspect code in an isolated workspace. Does not grant code publication or task editing.', 76259328, 1, NULL, '2026-10-28T13:21:58.351Z', '2026-10-28T13:21:58.351Z');
--> statement-breakpoint
INSERT INTO `project_policies` (`id`, `name`, `description`, `permissions_bitmask`, `version`, `created_by`, `created_at`, `updated_at`) VALUES ('project-policy-coordinator', 'Coordinator', 'Read and organize project tasks and invoke agents. Does not grant computer access or code publication.', 68689920, 1, NULL, '2026-10-28T13:21:58.351Z', '2026-10-28T13:21:58.351Z');
--> statement-breakpoint
INSERT INTO `project_policies` (`id`, `name`, `description`, `permissions_bitmask`, `version`, `created_by`, `created_at`, `updated_at`) VALUES ('project-policy-task-coordinator', 'Task coordinator', 'Organize project tasks and delegate work to agents. Does not grant computer access or code publication.', 337190912, 1, NULL, '2026-10-28T13:21:58.351Z', '2026-10-28T13:21:58.351Z');
--> statement-breakpoint
INSERT INTO `project_policies` (`id`, `name`, `description`, `permissions_bitmask`, `version`, `created_by`, `created_at`, `updated_at`) VALUES ('server-policy-owner', 'Server owner', 'All server permissions.', 2147483647, 1, NULL, '2026-10-28T13:21:58.352Z', '2026-10-28T13:21:58.352Z');
--> statement-breakpoint
INSERT INTO `project_policies` (`id`, `name`, `description`, `permissions_bitmask`, `version`, `created_by`, `created_at`, `updated_at`) VALUES ('server-policy-admin', 'Server administrator', 'Manage the server.', 2130243583, 1, NULL, '2026-10-28T13:21:58.352Z', '2026-10-28T13:21:58.352Z');
--> statement-breakpoint
INSERT INTO `project_policies` (`id`, `name`, `description`, `permissions_bitmask`, `version`, `created_by`, `created_at`, `updated_at`) VALUES ('server-policy-member', 'Server member', 'Participate in server conversations.', 112, 1, NULL, '2026-10-28T13:21:58.352Z', '2026-10-28T13:21:58.352Z');
--> statement-breakpoint
CREATE UNIQUE INDEX `account_recovery_code_hash_unique` ON `account_recovery` (`code_hash`);
--> statement-breakpoint
CREATE INDEX `agent_turns_channel_agent_idx` ON `agent_turns` (`channel_id`,`agent_id`,`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_turns_request_id_unique` ON `agent_turns` (`request_id`);
--> statement-breakpoint
CREATE INDEX `agents_status_idx` ON `agents` (`status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `attachments_r2_key_unique` ON `attachments` (`r2_key`);
--> statement-breakpoint
CREATE INDEX `attachments_message_id_idx` ON `attachments` (`message_id`);
--> statement-breakpoint
CREATE INDEX `attachments_channel_id_idx` ON `attachments` (`channel_id`);
--> statement-breakpoint
CREATE INDEX `attachments_uploader_id_idx` ON `attachments` (`uploader_id`);
--> statement-breakpoint
CREATE INDEX `audit_log_created_at_idx` ON `audit_log` (`created_at`);
--> statement-breakpoint
CREATE INDEX `audit_log_actor_id_idx` ON `audit_log` (`actor_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_accounts_provider_account_idx` ON `auth_accounts` (`provider_id`,`account_id`);
--> statement-breakpoint
CREATE INDEX `auth_accounts_user_id_idx` ON `auth_accounts` (`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_sessions_token_unique` ON `auth_sessions` (`token`);
--> statement-breakpoint
CREATE INDEX `auth_sessions_user_id_idx` ON `auth_sessions` (`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_users_email_unique` ON `auth_users` (`email`);
--> statement-breakpoint
CREATE UNIQUE INDEX `canvas_edges_nodes_unique` ON `canvas_edges` (`canvas_id`,`from_node_id`,`to_node_id`);
--> statement-breakpoint
CREATE INDEX `canvas_edges_canvas_idx` ON `canvas_edges` (`canvas_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `canvas_nodes_canvas_idx` ON `canvas_nodes` (`canvas_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `canvases_position_idx` ON `canvases` (`position`);
--> statement-breakpoint
CREATE INDEX `channel_categories_position_idx` ON `channel_categories` (`position`);
--> statement-breakpoint
CREATE INDEX `channel_members_user_id_idx` ON `channel_members` (`user_id`);
--> statement-breakpoint
CREATE INDEX `channel_reads_user_id_idx` ON `channel_reads` (`user_id`);
--> statement-breakpoint
CREATE INDEX `channel_role_overrides_role_id_idx` ON `channel_role_overrides` (`role_id`);
--> statement-breakpoint
CREATE INDEX `channels_position_idx` ON `channels` (`position`);
--> statement-breakpoint
CREATE INDEX `channels_type_idx` ON `channels` (`type`);
--> statement-breakpoint
CREATE INDEX `channels_category_id_idx` ON `channels` (`category_id`);
--> statement-breakpoint
CREATE INDEX `channels_parent_id_idx` ON `channels` (`parent_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `channels_thread_root_unique` ON `channels` (`parent_message_id`) WHERE "channels"."type" = 'thread';
--> statement-breakpoint
CREATE INDEX `data_bookmarks_user_position_idx` ON `data_bookmarks` (`user_id`,`position`,`created_at`);
--> statement-breakpoint
CREATE INDEX `database_definitions_position_idx` ON `database_definitions` (`position`);
--> statement-breakpoint
CREATE UNIQUE INDEX `database_fields_name_unique` ON `database_fields` (`database_id`,`name`);
--> statement-breakpoint
CREATE UNIQUE INDEX `database_fields_slot_unique` ON `database_fields` (`database_id`,`type`,`slot`);
--> statement-breakpoint
CREATE INDEX `database_fields_position_idx` ON `database_fields` (`database_id`,`position`);
--> statement-breakpoint
CREATE INDEX `database_items_database_position_idx` ON `database_items` (`database_id`,`position`);
--> statement-breakpoint
CREATE UNIQUE INDEX `database_views_name_unique` ON `database_views` (`database_id`,`name`);
--> statement-breakpoint
CREATE INDEX `database_views_database_position_idx` ON `database_views` (`database_id`,`position`);
--> statement-breakpoint
CREATE INDEX `documents_position_idx` ON `documents` (`position`);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_domains_domain_unique` ON `email_domains` (`domain`);
--> statement-breakpoint
CREATE INDEX `email_mailbox_access_user_idx` ON `email_mailbox_access` (`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_mailboxes_address_unique` ON `email_mailboxes` (`domain_id`,`local_part`);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_messages_mailbox_rfc_message_id_unique` ON `email_messages` (`mailbox_channel_id`,`rfc_message_id`) WHERE "email_messages"."rfc_message_id" is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX `email_messages_mailbox_client_request_unique` ON `email_messages` (`mailbox_channel_id`,`client_request_id`) WHERE "email_messages"."client_request_id" is not null;
--> statement-breakpoint
CREATE INDEX `email_messages_thread_created_idx` ON `email_messages` (`thread_channel_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `email_threads_mailbox_status_latest_idx` ON `email_threads` (`mailbox_channel_id`,`status`,`last_message_at`);
--> statement-breakpoint
CREATE INDEX `gadget_draft_role_access_role_idx` ON `gadget_draft_role_access` (`role_id`,`gadget_id`);
--> statement-breakpoint
CREATE INDEX `gadget_version_role_access_role_idx` ON `gadget_version_role_access` (`role_id`,`gadget_version_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `gadget_versions_number_unique` ON `gadget_versions` (`gadget_id`,`version`);
--> statement-breakpoint
CREATE INDEX `gadgets_position_idx` ON `gadgets` (`position`,`created_at`);
--> statement-breakpoint
CREATE INDEX `invites_creator_id_idx` ON `invites` (`creator_id`);
--> statement-breakpoint
CREATE INDEX `invites_expires_at_idx` ON `invites` (`expires_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_access_tokens_hash_unique` ON `mcp_access_tokens` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `mcp_access_tokens_subject_id_idx` ON `mcp_access_tokens` (`subject_id`);
--> statement-breakpoint
CREATE INDEX `mcp_access_tokens_created_by_idx` ON `mcp_access_tokens` (`created_by`);
--> statement-breakpoint
CREATE INDEX `mcp_access_tokens_active_idx` ON `mcp_access_tokens` (`revoked_at`,`created_at`);
--> statement-breakpoint
CREATE INDEX `message_mentions_user_id_idx` ON `message_mentions` (`user_id`);
--> statement-breakpoint
CREATE INDEX `message_pins_pinned_by_idx` ON `message_pins` (`pinned_by`);
--> statement-breakpoint
CREATE INDEX `message_pins_pinned_at_idx` ON `message_pins` (`pinned_at`);
--> statement-breakpoint
CREATE INDEX `message_reactions_user_id_idx` ON `message_reactions` (`user_id`);
--> statement-breakpoint
CREATE INDEX `messages_channel_created_idx` ON `messages` (`channel_id`,`created_at`,`id`);
--> statement-breakpoint
CREATE INDEX `messages_author_id_idx` ON `messages` (`author_id`);
--> statement-breakpoint
CREATE INDEX `onboarding_acceptances_revision_idx` ON `onboarding_acceptances` (`revision_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `onboarding_revisions_version_unique` ON `onboarding_revisions` (`version`);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);
--> statement-breakpoint
CREATE INDEX `push_subscriptions_user_id_idx` ON `push_subscriptions` (`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `roles_key_unique` ON `roles` (`key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `server_singleton_idx` ON `server` (`singleton`);
--> statement-breakpoint
CREATE UNIQUE INDEX `server_identity_singleton_unique` ON `server_identity` (`singleton`);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_attachments_r2_key_unique` ON `task_attachments` (`r2_key`);
--> statement-breakpoint
CREATE INDEX `task_attachments_task_created_idx` ON `task_attachments` (`task_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `task_boards_position_idx` ON `task_boards` (`position`);
--> statement-breakpoint
CREATE INDEX `task_checklist_items_task_position_idx` ON `task_checklist_items` (`task_id`,`position`);
--> statement-breakpoint
CREATE INDEX `task_dependencies_depends_on_idx` ON `task_dependencies` (`depends_on_task_id`);
--> statement-breakpoint
CREATE INDEX `task_label_links_label_idx` ON `task_label_links` (`label_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_labels_board_name_unique` ON `task_labels` (`board_id`,`name`);
--> statement-breakpoint
CREATE INDEX `task_labels_board_position_idx` ON `task_labels` (`board_id`,`position`);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_numbers_number_unique` ON `task_numbers` (`number`);
--> statement-breakpoint
CREATE INDEX `tasks_board_status_position_idx` ON `tasks` (`board_id`,`status`,`position`);
--> statement-breakpoint
CREATE INDEX `tasks_assignee_id_idx` ON `tasks` (`assignee_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_discussion_channel_unique` ON `tasks` (`discussion_channel_id`) WHERE "tasks"."discussion_channel_id" is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX `users_handle_unique` ON `users` (`handle`);
--> statement-breakpoint
CREATE INDEX `users_status_idx` ON `users` (`status`);
--> statement-breakpoint
CREATE INDEX `users_kind_idx` ON `users` (`kind`);
--> statement-breakpoint
CREATE INDEX `users_role_id_idx` ON `users` (`role_id`);
--> statement-breakpoint
CREATE INDEX `mcp_oauth_connections_created_by_idx` ON `mcp_oauth_connections` (`created_by`);
--> statement-breakpoint
CREATE INDEX `mcp_oauth_connections_subject_id_idx` ON `mcp_oauth_connections` (`subject_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_oauth_access_token_token_unique` ON `auth_oauth_access_token` (`token`);
--> statement-breakpoint
CREATE INDEX `auth_oauth_access_token_client_id_idx` ON `auth_oauth_access_token` (`client_id`);
--> statement-breakpoint
CREATE INDEX `auth_oauth_access_token_session_id_idx` ON `auth_oauth_access_token` (`session_id`);
--> statement-breakpoint
CREATE INDEX `auth_oauth_access_token_user_id_idx` ON `auth_oauth_access_token` (`user_id`);
--> statement-breakpoint
CREATE INDEX `auth_oauth_access_token_authorization_code_id_idx` ON `auth_oauth_access_token` (`authorization_code_id`);
--> statement-breakpoint
CREATE INDEX `auth_oauth_access_token_refresh_id_idx` ON `auth_oauth_access_token` (`refresh_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_oauth_client_client_id_unique` ON `auth_oauth_client` (`client_id`);
--> statement-breakpoint
CREATE INDEX `auth_oauth_client_user_id_idx` ON `auth_oauth_client` (`user_id`);
--> statement-breakpoint
CREATE INDEX `auth_oauth_client_resource_client_id_idx` ON `auth_oauth_client_resource` (`client_id`);
--> statement-breakpoint
CREATE INDEX `auth_oauth_client_resource_resource_id_idx` ON `auth_oauth_client_resource` (`resource_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_oauth_client_resource_client_id_resource_id_unique` ON `auth_oauth_client_resource` (`client_id`,`resource_id`);
--> statement-breakpoint
CREATE INDEX `auth_oauth_consent_client_id_idx` ON `auth_oauth_consent` (`client_id`);
--> statement-breakpoint
CREATE INDEX `auth_oauth_consent_user_id_idx` ON `auth_oauth_consent` (`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_oauth_refresh_token_token_unique` ON `auth_oauth_refresh_token` (`token`);
--> statement-breakpoint
CREATE INDEX `auth_oauth_refresh_token_client_id_idx` ON `auth_oauth_refresh_token` (`client_id`);
--> statement-breakpoint
CREATE INDEX `auth_oauth_refresh_token_session_id_idx` ON `auth_oauth_refresh_token` (`session_id`);
--> statement-breakpoint
CREATE INDEX `auth_oauth_refresh_token_user_id_idx` ON `auth_oauth_refresh_token` (`user_id`);
--> statement-breakpoint
CREATE INDEX `auth_oauth_refresh_token_authorization_code_id_idx` ON `auth_oauth_refresh_token` (`authorization_code_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_oauth_resource_identifier_unique` ON `auth_oauth_resource` (`identifier`);
--> statement-breakpoint
CREATE INDEX agent_runs_session_status ON agent_runs(session_id,status,created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX server_domains_hostname_unique ON server_domains (hostname);
--> statement-breakpoint
CREATE UNIQUE INDEX server_domains_single_primary ON server_domains (is_primary) WHERE is_primary = 1;
--> statement-breakpoint
CREATE INDEX server_domain_requests_status_idx ON server_domain_requests (status, created_at);
--> statement-breakpoint
CREATE INDEX file_deletions_scope_idx ON file_deletions(scope_id);
--> statement-breakpoint
CREATE INDEX mcp_outbound_server_owner ON mcp_outbound_connections(server_id,owner_id);
--> statement-breakpoint
CREATE UNIQUE INDEX agent_run_publication_active ON agent_run_publications(run_id) WHERE status IN ('pending','executing','completed','uncertain');
--> statement-breakpoint
CREATE INDEX agent_run_publication_history ON agent_run_publications(run_id,created_at);
--> statement-breakpoint
CREATE INDEX project_repositories_project ON project_repositories(project_id);
--> statement-breakpoint
CREATE INDEX tasks_project ON tasks(project_id);
--> statement-breakpoint
CREATE INDEX factory_actions_node_queue ON factory_actions(status,created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX factory_one_active_action ON factory_actions(workspace_id) WHERE status IN ('pending','approved','claimed','executing','uncertain');
--> statement-breakpoint
CREATE UNIQUE INDEX project_policy_members ON project_policy_assignments(project_id,policy_id,member_id) WHERE member_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX project_policy_roles ON project_policy_assignments(project_id,policy_id,role_id) WHERE role_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX project_policy_assignments_member ON project_policy_assignments(member_id,project_id);
--> statement-breakpoint
CREATE INDEX project_policy_assignments_role ON project_policy_assignments(role_id,project_id);
--> statement-breakpoint
CREATE INDEX agent_runs_root ON agent_runs(COALESCE(json_extract(mandate_json,'$.rootRunId'),id));
--> statement-breakpoint
CREATE INDEX agent_schedules_created_by_status_idx ON agent_schedules(created_by,status,next_at);
--> statement-breakpoint
CREATE INDEX agent_schedules_principal_status_idx ON agent_schedules(principal_id,status,next_at);
--> statement-breakpoint
CREATE UNIQUE INDEX channels_dm_pair_key_unique ON channels(dm_pair_key) WHERE dm_pair_key IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `messages_live_channel_id_idx` ON `messages` (`channel_id`,`id`) WHERE `deleted_at` IS NULL;
--> statement-breakpoint
CREATE INDEX `tasks_source_message_idx` ON `tasks` (`source_channel_id`, `source_message_id`) WHERE `source_message_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `notification_outbox_due_idx` ON `notification_outbox` (`available_at`) WHERE "notification_outbox"."delivered_at" is null and "notification_outbox"."failed_at" is null;
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
CREATE TRIGGER agents_pi_only_insert AFTER INSERT ON agents WHEN NEW.harness <> 'pi' BEGIN UPDATE agents SET harness='pi' WHERE user_id=NEW.user_id; END;
--> statement-breakpoint
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
CREATE TRIGGER role_policy_insert AFTER INSERT ON role_policies BEGIN UPDATE roles SET permissions_bitmask = (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 1) <> 0) THEN 1 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 2) <> 0) THEN 2 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 4) <> 0) THEN 4 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 8) <> 0) THEN 8 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 16) <> 0) THEN 16 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 32) <> 0) THEN 32 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 64) <> 0) THEN 64 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 128) <> 0) THEN 128 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 256) <> 0) THEN 256 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 512) <> 0) THEN 512 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 1024) <> 0) THEN 1024 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 2048) <> 0) THEN 2048 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 4096) <> 0) THEN 4096 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 8192) <> 0) THEN 8192 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 16384) <> 0) THEN 16384 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 32768) <> 0) THEN 32768 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 65536) <> 0) THEN 65536 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 131072) <> 0) THEN 131072 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 262144) <> 0) THEN 262144 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 524288) <> 0) THEN 524288 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 1048576) <> 0) THEN 1048576 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 2097152) <> 0) THEN 2097152 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 4194304) <> 0) THEN 4194304 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 8388608) <> 0) THEN 8388608 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 16777216) <> 0) THEN 16777216 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 33554432) <> 0) THEN 33554432 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 67108864) <> 0) THEN 67108864 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 134217728) <> 0) THEN 134217728 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 268435456) <> 0) THEN 268435456 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 536870912) <> 0) THEN 536870912 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 1073741824) <> 0) THEN 1073741824 ELSE 0 END) WHERE id=NEW.role_id; END;
--> statement-breakpoint
CREATE TRIGGER role_policy_delete AFTER DELETE ON role_policies BEGIN UPDATE roles SET permissions_bitmask = (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 1) <> 0) THEN 1 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 2) <> 0) THEN 2 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 4) <> 0) THEN 4 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 8) <> 0) THEN 8 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 16) <> 0) THEN 16 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 32) <> 0) THEN 32 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 64) <> 0) THEN 64 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 128) <> 0) THEN 128 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 256) <> 0) THEN 256 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 512) <> 0) THEN 512 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 1024) <> 0) THEN 1024 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 2048) <> 0) THEN 2048 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 4096) <> 0) THEN 4096 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 8192) <> 0) THEN 8192 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 16384) <> 0) THEN 16384 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 32768) <> 0) THEN 32768 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 65536) <> 0) THEN 65536 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 131072) <> 0) THEN 131072 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 262144) <> 0) THEN 262144 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 524288) <> 0) THEN 524288 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 1048576) <> 0) THEN 1048576 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 2097152) <> 0) THEN 2097152 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 4194304) <> 0) THEN 4194304 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 8388608) <> 0) THEN 8388608 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 16777216) <> 0) THEN 16777216 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 33554432) <> 0) THEN 33554432 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 67108864) <> 0) THEN 67108864 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 134217728) <> 0) THEN 134217728 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 268435456) <> 0) THEN 268435456 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 536870912) <> 0) THEN 536870912 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 1073741824) <> 0) THEN 1073741824 ELSE 0 END) WHERE id=OLD.role_id; END;
--> statement-breakpoint
CREATE TRIGGER role_policy_update AFTER UPDATE OF permissions_bitmask ON project_policies BEGIN UPDATE roles SET permissions_bitmask = (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 1) <> 0) THEN 1 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 2) <> 0) THEN 2 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 4) <> 0) THEN 4 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 8) <> 0) THEN 8 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 16) <> 0) THEN 16 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 32) <> 0) THEN 32 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 64) <> 0) THEN 64 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 128) <> 0) THEN 128 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 256) <> 0) THEN 256 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 512) <> 0) THEN 512 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 1024) <> 0) THEN 1024 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 2048) <> 0) THEN 2048 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 4096) <> 0) THEN 4096 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 8192) <> 0) THEN 8192 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 16384) <> 0) THEN 16384 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 32768) <> 0) THEN 32768 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 65536) <> 0) THEN 65536 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 131072) <> 0) THEN 131072 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 262144) <> 0) THEN 262144 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 524288) <> 0) THEN 524288 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 1048576) <> 0) THEN 1048576 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 2097152) <> 0) THEN 2097152 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 4194304) <> 0) THEN 4194304 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 8388608) <> 0) THEN 8388608 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 16777216) <> 0) THEN 16777216 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 33554432) <> 0) THEN 33554432 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 67108864) <> 0) THEN 67108864 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 134217728) <> 0) THEN 134217728 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 268435456) <> 0) THEN 268435456 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 536870912) <> 0) THEN 536870912 ELSE 0 END) + (CASE WHEN EXISTS (SELECT 1 FROM role_policies rp JOIN project_policies p ON p.id=rp.policy_id WHERE rp.role_id=roles.id AND (p.permissions_bitmask & 1073741824) <> 0) THEN 1073741824 ELSE 0 END) WHERE id IN (SELECT role_id FROM role_policies WHERE policy_id=NEW.id); END;
--> statement-breakpoint
CREATE TRIGGER role_default_policy AFTER INSERT ON roles WHEN NEW.key IN ('owner','admin','member') BEGIN INSERT INTO role_policies(role_id,policy_id) VALUES (NEW.id, CASE NEW.key WHEN 'owner' THEN 'server-policy-owner' WHEN 'admin' THEN 'server-policy-admin' ELSE 'server-policy-member' END); END;
