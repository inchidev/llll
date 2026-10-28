-- Anyone may mention a mentionable Role; otherwise only the Owner and Members with Manage channels can.
ALTER TABLE `roles` ADD `mentionable` integer DEFAULT false NOT NULL;
--> statement-breakpoint
-- A mention row reached its Member through this Role. NULL is a direct mention. There is
-- deliberately no foreign key: deleting the Role keeps the mention in the Member's Inbox.
ALTER TABLE `message_mentions` ADD `role_id` text;
