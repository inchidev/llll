ALTER TABLE `task_boards` ADD COLUMN `archived_at` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD COLUMN `priority` text DEFAULT 'normal' NOT NULL
  CONSTRAINT `tasks_priority_check` CHECK (`priority` in ('low', 'normal', 'high', 'urgent'));
--> statement-breakpoint
ALTER TABLE `tasks` ADD COLUMN `due_at` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD COLUMN `archived_at` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD COLUMN `active_run_id` text;
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
CREATE UNIQUE INDEX `task_labels_board_name_unique` ON `task_labels` (`board_id`, `name`);
--> statement-breakpoint
CREATE INDEX `task_labels_board_position_idx` ON `task_labels` (`board_id`, `position`);
--> statement-breakpoint
CREATE TABLE `task_label_links` (
  `task_id` text NOT NULL,
  `label_id` text NOT NULL,
  PRIMARY KEY (`task_id`, `label_id`),
  FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`label_id`) REFERENCES `task_labels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `task_label_links_label_idx` ON `task_label_links` (`label_id`);
--> statement-breakpoint
CREATE TABLE `task_dependencies` (
  `task_id` text NOT NULL,
  `depends_on_task_id` text NOT NULL,
  `created_at` text NOT NULL,
  PRIMARY KEY (`task_id`, `depends_on_task_id`),
  FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`depends_on_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
  CONSTRAINT `task_dependencies_not_self_check` CHECK (`task_id` <> `depends_on_task_id`)
);
--> statement-breakpoint
CREATE INDEX `task_dependencies_depends_on_idx` ON `task_dependencies` (`depends_on_task_id`);
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
CREATE INDEX `task_checklist_items_task_position_idx` ON `task_checklist_items` (`task_id`, `position`);
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
  CONSTRAINT `task_attachments_size_check` CHECK (`size_bytes` > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_attachments_r2_key_unique` ON `task_attachments` (`r2_key`);
--> statement-breakpoint
CREATE INDEX `task_attachments_task_created_idx` ON `task_attachments` (`task_id`, `created_at`);
--> statement-breakpoint
ALTER TABLE `task_runs` RENAME TO `task_runs_old`;
--> statement-breakpoint
CREATE TABLE `task_runs` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL,
  `agent_id` text NOT NULL,
  `workflow_id` text,
  `status` text DEFAULT 'queued' NOT NULL,
  `triggered_by` text,
  `title_snapshot` text DEFAULT '' NOT NULL,
  `description_snapshot` text DEFAULT '' NOT NULL,
  `channel_id_snapshot` text,
  `agent_model_snapshot` text DEFAULT '' NOT NULL,
  `agent_instructions_snapshot` text DEFAULT '' NOT NULL,
  `task_status_before` text DEFAULT 'ready' NOT NULL,
  `summary` text,
  `details` text,
  `error` text,
  `progress` text,
  `started_at` text,
  `completed_at` text,
  `cancelled_at` text,
  `cancelled_by` text,
  `created_at` text NOT NULL,
  FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`agent_id`) REFERENCES `agents`(`user_id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`triggered_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`cancelled_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
  CONSTRAINT `task_runs_status_check` CHECK (`status` in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  CONSTRAINT `task_runs_previous_status_check` CHECK (`task_status_before` in ('backlog', 'ready', 'review', 'done', 'failed'))
);
--> statement-breakpoint
INSERT INTO `task_runs` (
  `id`, `task_id`, `agent_id`, `workflow_id`, `status`, `title_snapshot`, `description_snapshot`,
  `channel_id_snapshot`, `task_status_before`, `summary`, `details`, `error`, `progress`, `started_at`, `completed_at`, `created_at`
)
SELECT
  r.`id`, r.`task_id`, r.`agent_id`, r.`workflow_id`, r.`status`, t.`title`, t.`description`,
  t.`channel_id`, CASE WHEN t.`status` = 'running' THEN 'ready' ELSE t.`status` END,
  r.`summary`, r.`details`, r.`error`, r.`progress`, r.`started_at`, r.`completed_at`, r.`created_at`
FROM `task_runs_old` r JOIN `tasks` t ON t.`id` = r.`task_id`;
--> statement-breakpoint
DROP TABLE `task_runs_old`;
--> statement-breakpoint
CREATE UNIQUE INDEX `task_runs_workflow_id_unique` ON `task_runs` (`workflow_id`);
--> statement-breakpoint
CREATE INDEX `task_runs_task_created_idx` ON `task_runs` (`task_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `task_runs_agent_status_idx` ON `task_runs` (`agent_id`, `status`);
--> statement-breakpoint
UPDATE `roles`
SET `permissions_bitmask` = `permissions_bitmask` | 256
WHERE `key` IN ('owner', 'admin');
