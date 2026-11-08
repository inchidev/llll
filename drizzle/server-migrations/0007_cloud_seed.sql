CREATE TABLE `member_identities` (
	`provider` text NOT NULL,
	`subject` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`provider`, `subject`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `member_identities_user_id_unique` ON `member_identities` (`user_id`);--> statement-breakpoint
ALTER TABLE `server_setup` ADD `seed_json` text;