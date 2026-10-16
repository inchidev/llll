ALTER TABLE `mcp_access_tokens` ADD COLUMN `subject_id` text REFERENCES `users`(`id`) ON DELETE cascade;
--> statement-breakpoint
UPDATE `mcp_access_tokens` SET `subject_id` = `created_by` WHERE `subject_id` IS NULL;
--> statement-breakpoint
CREATE INDEX `mcp_access_tokens_subject_id_idx` ON `mcp_access_tokens` (`subject_id`);
--> statement-breakpoint
ALTER TABLE `task_runs` ADD COLUMN `approval_json` text;
