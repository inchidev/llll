CREATE TABLE `factory_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`box_id` text NOT NULL,
	`run_id` text NOT NULL,
	`call_id` text NOT NULL,
	`kind` text NOT NULL,
	`request_json` text NOT NULL,
	`digest` text NOT NULL,
	`status` text NOT NULL,
	`diff_key` text,
	`diff_digest` text,
	`decided_by` text,
	`decided_at` text,
	`expires_at` text NOT NULL,
	`result_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`box_id`) REFERENCES `factory_boxes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "factory_approvals_kind_check" CHECK("factory_approvals"."kind" IN ('plan','publish','window','merge')),
	CONSTRAINT "factory_approvals_status_check" CHECK("factory_approvals"."status" IN ('pending_diff','pending','approved','rejected','expired','completed','failed','uncertain'))
);
--> statement-breakpoint
CREATE INDEX `factory_approvals_box` ON `factory_approvals` (`box_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `factory_approvals_run_id_call_id_unique` ON `factory_approvals` (`run_id`,`call_id`);--> statement-breakpoint
CREATE TABLE `factory_boxes` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`task_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`initiated_by` text NOT NULL,
	`node_id` text NOT NULL,
	`environment_json` text NOT NULL,
	`origin_run_id` text NOT NULL,
	`run_id` text,
	`status` text DEFAULT 'new' NOT NULL,
	`lease_token` text,
	`lease_until` text,
	`cpu` real,
	`memory_mib` integer,
	`checkpoint_sha` text,
	`head_sha` text,
	`pull_json` text,
	`runtime_ms` integer DEFAULT 0 NOT NULL,
	`publication_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`user_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`initiated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`node_id`) REFERENCES `compute_nodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`origin_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "factory_boxes_status_check" CHECK("factory_boxes"."status" IN ('new','queued','starting','running','idle','stopped','released','failed'))
);
--> statement-breakpoint
CREATE INDEX `factory_boxes_node` ON `factory_boxes` (`node_id`,`status`);--> statement-breakpoint
CREATE INDEX `factory_boxes_run` ON `factory_boxes` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `factory_boxes_task_id_agent_id_initiated_by_unique` ON `factory_boxes` (`task_id`,`agent_id`,`initiated_by`);--> statement-breakpoint
CREATE TABLE `project_secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`placeholder` text NOT NULL,
	`hosts_json` text DEFAULT '[]' NOT NULL,
	`secret_ciphertext` text NOT NULL,
	`secret_iv` text NOT NULL,
	`secret_version` integer DEFAULT 1 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_used_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_secrets_project_id_name_unique` ON `project_secrets` (`project_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_secrets_project_id_placeholder_unique` ON `project_secrets` (`project_id`,`placeholder`);--> statement-breakpoint
ALTER TABLE `projects` ADD `factory_json` text;