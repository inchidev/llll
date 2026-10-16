-- Email messages belong to the mailbox that received or sent them.
--
-- An RFC Message-ID was unique across the installation, so one email delivered to
-- two mailboxes kept only the first copy, and a reply could join a thread in a
-- different mailbox. Record each message's mailbox and make the Message-ID unique
-- within it instead.
--
-- Outbound messages also record a client request key, so a retried send returns
-- the message already created instead of emailing twice, and their delivery
-- attempts, last error, and delivery time.
ALTER TABLE `email_messages` ADD `mailbox_channel_id` text REFERENCES `email_mailboxes`(`channel_id`) ON UPDATE no action ON DELETE cascade;
--> statement-breakpoint
UPDATE `email_messages` SET `mailbox_channel_id` = (
  SELECT `mailbox_channel_id` FROM `email_threads` WHERE `email_threads`.`channel_id` = `email_messages`.`thread_channel_id`
);
--> statement-breakpoint
DROP INDEX IF EXISTS `email_messages_rfc_message_id_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `email_messages_mailbox_rfc_message_id_unique` ON `email_messages` (`mailbox_channel_id`, `rfc_message_id`) WHERE `rfc_message_id` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `email_messages` ADD `client_request_id` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `email_messages_mailbox_client_request_unique` ON `email_messages` (`mailbox_channel_id`, `client_request_id`) WHERE `client_request_id` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `email_messages` ADD `delivery_attempts` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `email_messages` ADD `delivery_error` text;
--> statement-breakpoint
ALTER TABLE `email_messages` ADD `delivered_at` text;
--> statement-breakpoint
UPDATE `email_messages` SET `delivery_attempts` = 1 WHERE `direction` = 'outbound';
