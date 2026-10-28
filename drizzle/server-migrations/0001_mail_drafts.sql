CREATE TABLE `mail_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`mailbox_channel_id` text NOT NULL,
	`thread_channel_id` text,
	`author_id` text NOT NULL,
	`to_json` text DEFAULT '[]' NOT NULL,
	`cc_json` text DEFAULT '[]' NOT NULL,
	`bcc_json` text DEFAULT '[]' NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`body_format` text DEFAULT 'text' NOT NULL,
	`attachment_ids_json` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`mailbox_channel_id`) REFERENCES `email_mailboxes`(`channel_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_channel_id`) REFERENCES `email_threads`(`channel_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "mail_drafts_body_format_check" CHECK("mail_drafts"."body_format" in ('text', 'markdown'))
);
--> statement-breakpoint
CREATE INDEX `mail_drafts_author_mailbox_idx` ON `mail_drafts` (`author_id`,`mailbox_channel_id`,`updated_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `mail_drafts_author_thread_unique` ON `mail_drafts` (`author_id`,`thread_channel_id`) WHERE "mail_drafts"."thread_channel_id" is not null;
--> statement-breakpoint
ALTER TABLE `email_messages` ADD `body_format` text DEFAULT 'text' NOT NULL CONSTRAINT "email_messages_body_format_check" CHECK("body_format" in ('text', 'markdown'));
