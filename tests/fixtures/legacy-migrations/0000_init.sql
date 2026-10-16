CREATE TABLE IF NOT EXISTS `attachments` (
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
CREATE UNIQUE INDEX IF NOT EXISTS `attachments_r2_key_unique` ON `attachments` (`r2_key`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `attachments_message_id_idx` ON `attachments` (`message_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `attachments_channel_id_idx` ON `attachments` (`channel_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `attachments_uploader_id_idx` ON `attachments` (`uploader_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `audit_log` (
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
CREATE INDEX IF NOT EXISTS `audit_log_created_at_idx` ON `audit_log` (`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `audit_log_actor_id_idx` ON `audit_log` (`actor_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `auth_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`issuer` text NOT NULL,
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
CREATE UNIQUE INDEX IF NOT EXISTS `auth_accounts_issuer_account_idx` ON `auth_accounts` (`issuer`,`account_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `auth_accounts_user_id_idx` ON `auth_accounts` (`user_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `auth_sessions` (
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
CREATE UNIQUE INDEX IF NOT EXISTS `auth_sessions_token_unique` ON `auth_sessions` (`token`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `auth_sessions_user_id_idx` ON `auth_sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `auth_users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (cast(unixepoch() * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch() * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `auth_users_email_unique` ON `auth_users` (`email`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `auth_verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch() * 1000 as integer)),
	`updated_at` integer DEFAULT (cast(unixepoch() * 1000 as integer))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `channel_members` (
	`channel_id` text NOT NULL,
	`user_id` text NOT NULL,
	`hidden_at` text,
	`joined_at` text NOT NULL,
	PRIMARY KEY(`channel_id`, `user_id`),
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `channel_members_user_id_idx` ON `channel_members` (`user_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `channel_reads` (
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
CREATE INDEX IF NOT EXISTS `channel_reads_user_id_idx` ON `channel_reads` (`user_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `channels` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`topic` text DEFAULT '' NOT NULL,
	`type` text NOT NULL,
	`visibility` text DEFAULT 'workspace' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`huddle_meeting_id` text,
	`parent_id` text,
	`parent_message_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
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
CREATE INDEX IF NOT EXISTS `channels_position_idx` ON `channels` (`position`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `channels_type_idx` ON `channels` (`type`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `channels_parent_id_idx` ON `channels` (`parent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `channels_thread_root_unique` ON `channels` (`parent_message_id`) WHERE "channels"."type" = 'thread';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `invites` (
	`code` text PRIMARY KEY NOT NULL,
	`creator_id` text NOT NULL,
	`max_uses` integer DEFAULT 0 NOT NULL,
	`uses` integer DEFAULT 0 NOT NULL,
	`expires_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`creator_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `invites_creator_id_idx` ON `invites` (`creator_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `invites_expires_at_idx` ON `invites` (`expires_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `message_mentions` (
	`message_id` text NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`message_id`, `user_id`),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `message_mentions_user_id_idx` ON `message_mentions` (`user_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `message_reactions` (
	`message_id` text NOT NULL,
	`user_id` text NOT NULL,
	`emoji` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`message_id`, `user_id`, `emoji`),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `message_reactions_user_id_idx` ON `message_reactions` (`user_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `messages` (
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
CREATE INDEX IF NOT EXISTS `messages_channel_created_idx` ON `messages` (`channel_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `messages_author_id_idx` ON `messages` (`author_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `roles` (
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
CREATE UNIQUE INDEX IF NOT EXISTS `roles_key_unique` ON `roles` (`key`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `users` (
	`id` text PRIMARY KEY NOT NULL,
	`handle` text,
	`display_name` text NOT NULL,
	`avatar_r2_key` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`role_id` text,
	`nickname` text,
	`joined_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "users_status_check" CHECK("users"."status" in ('pending', 'active', 'removed')),
	CONSTRAINT "users_active_role_check" CHECK("users"."status" <> 'active' or ("users"."role_id" is not null and "users"."joined_at" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `users_handle_unique` ON `users` (`handle`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `users_status_idx` ON `users` (`status`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `users_role_id_idx` ON `users` (`role_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `workspace` (
	`id` text PRIMARY KEY DEFAULT 'main' NOT NULL,
	`name` text NOT NULL,
	`icon_r2_key` text,
	`owner_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "workspace_singleton_check" CHECK("workspace"."id" = 'main')
);
