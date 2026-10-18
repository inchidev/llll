CREATE TABLE `account_recovery` (
	`user_id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_recovery_code_hash_unique` ON `account_recovery` (`code_hash`);--> statement-breakpoint
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
CREATE TABLE `server_identity` (
	`singleton` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	CONSTRAINT "server_identity_singleton_check" CHECK("server_identity"."singleton" = 1),
 CONSTRAINT "server_identity_uuid_check" CHECK(length(id) = 36 AND substr(id,15,1) = '4' AND substr(id,20,1) IN ('8','9','a','b'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `server_identity_singleton_unique` ON `server_identity` (`singleton`);--> statement-breakpoint
CREATE TABLE __fresh_server_required (empty INTEGER NOT NULL CHECK(empty = 0));
--> statement-breakpoint
INSERT INTO __fresh_server_required SELECT count(*) FROM workspace;
--> statement-breakpoint
DROP TABLE __fresh_server_required;--> statement-breakpoint
CREATE TABLE `__new_workspace` (
	`id` text PRIMARY KEY NOT NULL,
	`singleton` integer DEFAULT 1 NOT NULL,
	`name` text NOT NULL,
	`icon_r2_key` text,
	`owner_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`id`) REFERENCES `server_identity`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "workspace_singleton_check" CHECK("__new_workspace"."singleton" = 1)
);
--> statement-breakpoint
INSERT INTO `__new_workspace`("id", "singleton", "name", "icon_r2_key", "owner_id", "created_at", "updated_at") SELECT "id", 1, "name", "icon_r2_key", "owner_id", "created_at", "updated_at" FROM `workspace`;--> statement-breakpoint
DROP TABLE `workspace`;--> statement-breakpoint
ALTER TABLE `__new_workspace` RENAME TO `workspace`;--> statement-breakpoint
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_singleton_idx` ON `workspace` (`singleton`);