-- An archived channel keeps its history readable but accepts no new activity and
-- leaves Chat navigation. Only root text channels are archived; their Threads follow them.
ALTER TABLE `channels` ADD `archived_at` text;
--> statement-breakpoint
ALTER TABLE `channels` ADD `archived_by` text REFERENCES `users`(`id`) ON DELETE SET NULL;
