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
	CONSTRAINT `scheduled_huddles_status_check` CHECK(`status` in ('scheduled', 'ready', 'started', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX `scheduled_huddles_channel_start_idx` ON `scheduled_huddles` (`channel_id`,`starts_at`);
--> statement-breakpoint
CREATE INDEX `scheduled_huddles_status_start_idx` ON `scheduled_huddles` (`status`,`starts_at`);
