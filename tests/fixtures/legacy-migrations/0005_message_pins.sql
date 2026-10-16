CREATE TABLE `message_pins` (
	`message_id` text PRIMARY KEY NOT NULL,
	`pinned_by` text NOT NULL,
	`pinned_at` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pinned_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `message_pins_pinned_by_idx` ON `message_pins` (`pinned_by`);--> statement-breakpoint
CREATE INDEX `message_pins_pinned_at_idx` ON `message_pins` (`pinned_at`);
