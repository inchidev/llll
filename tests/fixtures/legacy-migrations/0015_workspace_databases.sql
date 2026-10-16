CREATE TABLE `database_definitions` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `position` integer DEFAULT 0 NOT NULL,
  `created_by` text NOT NULL,
  `archived_at` text,
  `created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  `updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `database_definitions_position_idx` ON `database_definitions` (`position`);
--> statement-breakpoint
CREATE TABLE `database_fields` (
  `id` text PRIMARY KEY NOT NULL,
  `database_id` text NOT NULL,
  `name` text NOT NULL,
  `type` text NOT NULL,
  `slot` text NOT NULL,
  `config_json` text DEFAULT '{}' NOT NULL,
  `position` integer DEFAULT 0 NOT NULL,
  `created_by` text NOT NULL,
  `created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  `updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  FOREIGN KEY (`database_id`) REFERENCES `database_definitions`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
  CONSTRAINT `database_fields_type_check` CHECK (`type` in ('text', 'number', 'boolean', 'date', 'select'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `database_fields_name_unique` ON `database_fields` (`database_id`, `name`);
--> statement-breakpoint
CREATE UNIQUE INDEX `database_fields_slot_unique` ON `database_fields` (`database_id`, `type`, `slot`);
--> statement-breakpoint
CREATE INDEX `database_fields_position_idx` ON `database_fields` (`database_id`, `position`);
--> statement-breakpoint
CREATE TABLE `database_items` (
  `id` text PRIMARY KEY NOT NULL,
  `database_id` text NOT NULL,
  `title` text NOT NULL,
  `position` integer DEFAULT 0 NOT NULL,
  `version` integer DEFAULT 1 NOT NULL,
  `created_by` text NOT NULL,
  `text_1` text,
  `text_2` text,
  `text_3` text,
  `text_4` text,
  `text_5` text,
  `text_6` text,
  `text_7` text,
  `text_8` text,
  `text_9` text,
  `text_10` text,
  `text_11` text,
  `text_12` text,
  `text_13` text,
  `text_14` text,
  `text_15` text,
  `text_16` text,
  `number_1` real,
  `number_2` real,
  `number_3` real,
  `number_4` real,
  `number_5` real,
  `number_6` real,
  `number_7` real,
  `number_8` real,
  `boolean_1` integer,
  `boolean_2` integer,
  `boolean_3` integer,
  `boolean_4` integer,
  `boolean_5` integer,
  `boolean_6` integer,
  `boolean_7` integer,
  `boolean_8` integer,
  `date_1` text,
  `date_2` text,
  `date_3` text,
  `date_4` text,
  `date_5` text,
  `date_6` text,
  `date_7` text,
  `date_8` text,
  `select_1` text,
  `select_2` text,
  `select_3` text,
  `select_4` text,
  `select_5` text,
  `select_6` text,
  `select_7` text,
  `select_8` text,
  `created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  `updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  FOREIGN KEY (`database_id`) REFERENCES `database_definitions`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
  CONSTRAINT `database_items_version_check` CHECK (`version` > 0)
);
--> statement-breakpoint
CREATE INDEX `database_items_database_position_idx` ON `database_items` (`database_id`, `position`);
--> statement-breakpoint
UPDATE `roles`
SET `permissions_bitmask` = `permissions_bitmask` | 512
WHERE `key` IN ('owner', 'admin');
