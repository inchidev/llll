ALTER TABLE `users` ADD COLUMN `kind` text DEFAULT 'human' NOT NULL
  CONSTRAINT `users_kind_check` CHECK (`kind` in ('human', 'agent'));
--> statement-breakpoint
CREATE INDEX `users_kind_idx` ON `users` (`kind`);
--> statement-breakpoint
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
  CONSTRAINT `agents_status_check` CHECK (`status` in ('active', 'paused'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_computer_id_unique` ON `agents` (`computer_id`);
--> statement-breakpoint
CREATE INDEX `agents_status_idx` ON `agents` (`status`);
--> statement-breakpoint
CREATE TABLE `task_boards` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `position` integer DEFAULT 0 NOT NULL,
  `created_by` text NOT NULL,
  `created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  `updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `task_boards_position_idx` ON `task_boards` (`position`);
--> statement-breakpoint
CREATE TABLE `tasks` (
  `id` text PRIMARY KEY NOT NULL,
  `board_id` text NOT NULL,
  `title` text NOT NULL,
  `description` text DEFAULT '' NOT NULL,
  `status` text DEFAULT 'backlog' NOT NULL,
  `position` integer DEFAULT 0 NOT NULL,
  `assignee_id` text,
  `channel_id` text,
  `created_by` text NOT NULL,
  `result_summary` text,
  `result_details` text,
  `last_error` text,
  `created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  `updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  FOREIGN KEY (`board_id`) REFERENCES `task_boards`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`assignee_id`) REFERENCES `agents`(`user_id`) ON UPDATE no action ON DELETE set null,
  FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE set null,
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
  CONSTRAINT `tasks_status_check` CHECK (`status` in ('backlog', 'ready', 'running', 'review', 'done', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `tasks_board_status_position_idx` ON `tasks` (`board_id`, `status`, `position`);
--> statement-breakpoint
CREATE INDEX `tasks_assignee_id_idx` ON `tasks` (`assignee_id`);
--> statement-breakpoint
CREATE TABLE `task_runs` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL,
  `agent_id` text NOT NULL,
  `workflow_id` text,
  `status` text DEFAULT 'queued' NOT NULL,
  `summary` text,
  `details` text,
  `error` text,
  `started_at` text,
  `completed_at` text,
  `created_at` text NOT NULL,
  FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`agent_id`) REFERENCES `agents`(`user_id`) ON UPDATE no action ON DELETE no action,
  CONSTRAINT `task_runs_status_check` CHECK (`status` in ('queued', 'running', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_runs_workflow_id_unique` ON `task_runs` (`workflow_id`);
--> statement-breakpoint
CREATE INDEX `task_runs_task_created_idx` ON `task_runs` (`task_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `task_runs_agent_status_idx` ON `task_runs` (`agent_id`, `status`);
