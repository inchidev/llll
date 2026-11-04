CREATE TABLE `channel_attention` (
	`channel_id` text NOT NULL,
	`user_id` text NOT NULL,
	`following` integer DEFAULT false NOT NULL,
	`notifications` text DEFAULT 'default' NOT NULL,
	`read_generation` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`channel_id`, `user_id`),
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "channel_attention_notifications_check" CHECK("channel_attention"."notifications" in ('default', 'all', 'mentions', 'muted'))
);
--> statement-breakpoint
CREATE INDEX `channel_attention_user_idx` ON `channel_attention` (`user_id`,`following`);
--> statement-breakpoint
-- Keep existing thread subscriptions across the upgrade. New reads do not subscribe.
INSERT INTO channel_attention(channel_id, user_id, following)
SELECT r.channel_id, r.user_id, 1 FROM channel_reads r JOIN channels c ON c.id = r.channel_id
WHERE c.type = 'thread' AND r.last_read_message_id IS NOT NULL;
