CREATE TABLE `project_releases` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`repository_id` text,
	`repository` text NOT NULL,
	`tag` text NOT NULL,
	`version` text NOT NULL,
	`sha` text NOT NULL,
	`message` text DEFAULT '' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `project_repositories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `project_releases_project` ON `project_releases` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_releases_project_id_tag_unique` ON `project_releases` (`project_id`,`tag`);