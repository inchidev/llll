CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`user_agent` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);
--> statement-breakpoint
CREATE INDEX `push_subscriptions_user_id_idx` ON `push_subscriptions` (`user_id`);
--> statement-breakpoint
CREATE TABLE `notification_outbox` (
	`event_id` text NOT NULL,
	`subscription_id` text NOT NULL REFERENCES `push_subscriptions`(`id`) ON DELETE CASCADE,
	`recipient_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`kind` text NOT NULL,
	`channel_id` text NOT NULL REFERENCES `channels`(`id`) ON DELETE CASCADE,
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
	CONSTRAINT `notification_outbox_kind_check` CHECK(`kind` in ('mention', 'dm_message', 'huddle_started'))
);
--> statement-breakpoint
CREATE INDEX `notification_outbox_due_idx` ON `notification_outbox` (`available_at`)
WHERE `delivered_at` IS NULL AND `failed_at` IS NULL;
