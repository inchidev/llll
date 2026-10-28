-- Deleted Agents keep their profile row so messages, Runs and audit entries still
-- resolve. A deleted Agent's Member row is removed; these record when and by whom.
ALTER TABLE `agents` ADD `archived_at` text;
--> statement-breakpoint
ALTER TABLE `agents` ADD `archived_by` text;
--> statement-breakpoint
-- A Task can name the chat message it was created from. There is deliberately no
-- foreign key: removing the message keeps the Task, which then shows its source as deleted.
ALTER TABLE `tasks` ADD `source_channel_id` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `source_message_id` text;
--> statement-breakpoint
CREATE INDEX `tasks_source_message_idx` ON `tasks` (`source_channel_id`, `source_message_id`) WHERE `source_message_id` IS NOT NULL;
--> statement-breakpoint
-- Push notifications for inbound email need a new outbox kind. SQLite cannot change
-- a CHECK constraint in place, so the outbox is rebuilt with its rows and index.
CREATE TABLE `notification_outbox_next` (
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
INSERT INTO `notification_outbox_next` (`event_id`, `subscription_id`, `recipient_id`, `kind`, `channel_id`, `payload_json`, `attempts`, `available_at`, `lease_token`, `lease_until`, `delivered_at`, `failed_at`, `last_error`, `created_at`)
SELECT `event_id`, `subscription_id`, `recipient_id`, `kind`, `channel_id`, `payload_json`, `attempts`, `available_at`, `lease_token`, `lease_until`, `delivered_at`, `failed_at`, `last_error`, `created_at` FROM `notification_outbox`;
--> statement-breakpoint
DROP TABLE `notification_outbox`;
--> statement-breakpoint
ALTER TABLE `notification_outbox_next` RENAME TO `notification_outbox`;
--> statement-breakpoint
CREATE INDEX `notification_outbox_due_idx` ON `notification_outbox` (`available_at`) WHERE "notification_outbox"."delivered_at" is null and "notification_outbox"."failed_at" is null;
