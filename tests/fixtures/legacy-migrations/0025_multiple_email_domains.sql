PRAGMA defer_foreign_keys=ON;
--> statement-breakpoint
CREATE TABLE `email_domains_next` (
  `id` text PRIMARY KEY NOT NULL,
  `zone_id` text NOT NULL,
  `domain` text NOT NULL,
  `app_hostname` text NOT NULL,
  `created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  `updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `email_mailboxes_next` (
  `channel_id` text PRIMARY KEY NOT NULL,
  `domain_id` text NOT NULL,
  `local_part` text NOT NULL,
  `display_name` text NOT NULL,
  `enabled` integer DEFAULT true NOT NULL,
  `created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  `updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`domain_id`) REFERENCES `email_domains_next`(`id`) ON UPDATE no action ON DELETE cascade,
  CONSTRAINT `email_mailboxes_local_part_check` CHECK (`local_part` = lower(`local_part`) AND length(`local_part`) BETWEEN 1 AND 64)
);
--> statement-breakpoint
CREATE TABLE `email_mailbox_access_next` (
  `channel_id` text NOT NULL,
  `user_id` text NOT NULL,
  `permission` text DEFAULT 'read' NOT NULL,
  `created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  `updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  PRIMARY KEY (`channel_id`, `user_id`),
  FOREIGN KEY (`channel_id`) REFERENCES `email_mailboxes_next`(`channel_id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
  CONSTRAINT `email_mailbox_access_permission_check` CHECK (`permission` in ('read', 'send', 'manage'))
);
--> statement-breakpoint
CREATE TABLE `email_threads_next` (
  `channel_id` text PRIMARY KEY NOT NULL,
  `mailbox_channel_id` text NOT NULL,
  `subject` text NOT NULL,
  `status` text DEFAULT 'inbox' NOT NULL,
  `participants_json` text DEFAULT '[]' NOT NULL,
  `last_message_at` text NOT NULL,
  `created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  `updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`mailbox_channel_id`) REFERENCES `email_mailboxes_next`(`channel_id`) ON UPDATE no action ON DELETE cascade,
  CONSTRAINT `email_threads_status_check` CHECK (`status` in ('inbox', 'archive', 'spam', 'trash'))
);
--> statement-breakpoint
CREATE TABLE `email_messages_next` (
  `message_id` text PRIMARY KEY NOT NULL,
  `thread_channel_id` text NOT NULL,
  `direction` text NOT NULL,
  `from_address` text NOT NULL,
  `from_name` text,
  `to_json` text DEFAULT '[]' NOT NULL,
  `cc_json` text DEFAULT '[]' NOT NULL,
  `bcc_json` text DEFAULT '[]' NOT NULL,
  `rfc_message_id` text,
  `in_reply_to` text,
  `references_json` text DEFAULT '[]' NOT NULL,
  `delivery_status` text DEFAULT 'received' NOT NULL,
  `raw_r2_key` text,
  `created_at` text NOT NULL,
  FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`thread_channel_id`) REFERENCES `email_threads_next`(`channel_id`) ON UPDATE no action ON DELETE cascade,
  CONSTRAINT `email_messages_direction_check` CHECK (`direction` in ('inbound', 'outbound')),
  CONSTRAINT `email_messages_delivery_status_check` CHECK (`delivery_status` in ('received', 'pending', 'sent', 'failed'))
);
--> statement-breakpoint
INSERT INTO `email_domains_next` SELECT * FROM `email_domains`;
--> statement-breakpoint
INSERT INTO `email_mailboxes_next` SELECT * FROM `email_mailboxes`;
--> statement-breakpoint
INSERT INTO `email_mailbox_access_next` SELECT * FROM `email_mailbox_access`;
--> statement-breakpoint
INSERT INTO `email_threads_next` SELECT * FROM `email_threads`;
--> statement-breakpoint
INSERT INTO `email_messages_next` SELECT * FROM `email_messages`;
--> statement-breakpoint
DROP TABLE `email_messages`;
--> statement-breakpoint
DROP TABLE `email_threads`;
--> statement-breakpoint
DROP TABLE `email_mailbox_access`;
--> statement-breakpoint
DROP TABLE `email_mailboxes`;
--> statement-breakpoint
DROP TABLE `email_domains`;
--> statement-breakpoint
ALTER TABLE `email_domains_next` RENAME TO `email_domains`;
--> statement-breakpoint
ALTER TABLE `email_mailboxes_next` RENAME TO `email_mailboxes`;
--> statement-breakpoint
ALTER TABLE `email_mailbox_access_next` RENAME TO `email_mailbox_access`;
--> statement-breakpoint
ALTER TABLE `email_threads_next` RENAME TO `email_threads`;
--> statement-breakpoint
ALTER TABLE `email_messages_next` RENAME TO `email_messages`;
--> statement-breakpoint
CREATE UNIQUE INDEX `email_domains_domain_unique` ON `email_domains` (`domain`);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_mailboxes_address_unique` ON `email_mailboxes` (`domain_id`, `local_part`);
--> statement-breakpoint
CREATE INDEX `email_mailbox_access_user_idx` ON `email_mailbox_access` (`user_id`);
--> statement-breakpoint
CREATE INDEX `email_threads_mailbox_status_latest_idx` ON `email_threads` (`mailbox_channel_id`, `status`, `last_message_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_messages_rfc_message_id_unique` ON `email_messages` (`rfc_message_id`) WHERE `rfc_message_id` is not null;
--> statement-breakpoint
CREATE INDEX `email_messages_thread_created_idx` ON `email_messages` (`thread_channel_id`, `created_at`);
--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;
