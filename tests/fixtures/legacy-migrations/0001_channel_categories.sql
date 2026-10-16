CREATE TABLE `channel_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `channel_categories_position_idx` ON `channel_categories` (`position`);--> statement-breakpoint
ALTER TABLE `channels` ADD `category_id` text REFERENCES channel_categories(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `channels_category_id_idx` ON `channels` (`category_id`);--> statement-breakpoint
INSERT INTO `channel_categories` (`id`, `name`, `position`)
SELECT 'default-channels', 'Channels', 0
WHERE EXISTS (SELECT 1 FROM `workspace` WHERE `id` = 'main');--> statement-breakpoint
UPDATE `channels`
SET `category_id` = 'default-channels'
WHERE `category_id` IS NULL AND `type` IN ('text', 'voice');
