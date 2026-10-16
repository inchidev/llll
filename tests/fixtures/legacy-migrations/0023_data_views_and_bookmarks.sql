CREATE TABLE `database_views` (
  `id` text PRIMARY KEY NOT NULL,
  `database_id` text NOT NULL,
  `name` text NOT NULL,
  `layout` text DEFAULT 'table' NOT NULL,
  `config_json` text DEFAULT '{"visibleFieldIds":null,"filters":[],"sorts":[{"fieldId":"title","direction":"asc"}],"groupFieldId":null,"dateFieldId":null}' NOT NULL,
  `position` integer DEFAULT 0 NOT NULL,
  `version` integer DEFAULT 1 NOT NULL,
  `created_by` text NOT NULL,
  `created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  `updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  FOREIGN KEY (`database_id`) REFERENCES `database_definitions`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
  CONSTRAINT `database_views_layout_check` CHECK (`layout` in ('table', 'board', 'calendar', 'list')),
  CONSTRAINT `database_views_version_check` CHECK (`version` > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `database_views_name_unique` ON `database_views` (`database_id`, `name`);
--> statement-breakpoint
CREATE INDEX `database_views_database_position_idx` ON `database_views` (`database_id`, `position`);
--> statement-breakpoint
INSERT INTO `database_views` (`id`, `database_id`, `name`, `layout`, `position`, `created_by`, `created_at`, `updated_at`)
SELECT 'default:' || `id`, `id`, 'All records', 'table', 1024, `created_by`, `created_at`, `updated_at`
FROM `database_definitions`;
--> statement-breakpoint
CREATE TRIGGER `database_default_view_after_insert` AFTER INSERT ON `database_definitions` BEGIN
  INSERT INTO `database_views` (`id`, `database_id`, `name`, `layout`, `position`, `created_by`, `created_at`, `updated_at`)
  VALUES ('default:' || NEW.`id`, NEW.`id`, 'All records', 'table', 1024, NEW.`created_by`, NEW.`created_at`, NEW.`updated_at`);
END;
--> statement-breakpoint
CREATE TABLE `data_bookmarks` (
  `user_id` text NOT NULL,
  `target_type` text NOT NULL,
  `target_id` text NOT NULL,
  `position` integer DEFAULT 0 NOT NULL,
  `created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  PRIMARY KEY (`user_id`, `target_type`, `target_id`),
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
  CONSTRAINT `data_bookmarks_target_type_check` CHECK (`target_type` in ('database_view', 'document', 'canvas'))
);
--> statement-breakpoint
CREATE INDEX `data_bookmarks_user_position_idx` ON `data_bookmarks` (`user_id`, `position`, `created_at`);
--> statement-breakpoint
CREATE TRIGGER `database_view_bookmarks_after_delete` AFTER DELETE ON `database_views` BEGIN
  DELETE FROM `data_bookmarks` WHERE `target_type` = 'database_view' AND `target_id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `document_bookmarks_after_delete` AFTER DELETE ON `documents` BEGIN
  DELETE FROM `data_bookmarks` WHERE `target_type` = 'document' AND `target_id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `canvas_bookmarks_after_delete` AFTER DELETE ON `canvases` BEGIN
  DELETE FROM `data_bookmarks` WHERE `target_type` = 'canvas' AND `target_id` = OLD.`id`;
END;
