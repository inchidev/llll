-- The pull request a Task's agent published and its latest preview, so the
-- conversation the Task came from can link them.
ALTER TABLE `tasks` ADD `pull_url` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `preview_url` text;
