-- Tasks can be assigned to any active member, human or agent, and each task can
-- own a hidden discussion channel.
--
-- `tasks.assignee_id` references `agents(user_id)`, so it cannot hold a person.
-- SQLite cannot change a foreign key in place, and rebuilding `tasks` would
-- cascade-delete its numbers, checklist items, dependencies, labels, and
-- attachments. Add `assignee_user_id` instead, move existing assignments into it,
-- and leave the retired `assignee_id` empty.
ALTER TABLE `tasks` ADD `assignee_user_id` text REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null;
--> statement-breakpoint
UPDATE `tasks` SET `assignee_user_id` = `assignee_id`, `assignee_id` = NULL WHERE `assignee_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `tasks_assignee_user_id_idx` ON `tasks` (`assignee_user_id`);
--> statement-breakpoint
ALTER TABLE `tasks` ADD `discussion_channel_id` text REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE set null;
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_discussion_channel_unique` ON `tasks` (`discussion_channel_id`) WHERE `discussion_channel_id` IS NOT NULL;
