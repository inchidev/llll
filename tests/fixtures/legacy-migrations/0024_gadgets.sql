CREATE TABLE `gadgets` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `description` text DEFAULT '' NOT NULL,
  `draft_spec_json` text NOT NULL,
  `draft_revision` integer DEFAULT 1 NOT NULL,
  `published_version` integer,
  `position` integer DEFAULT 0 NOT NULL,
  `created_by` text NOT NULL,
  `created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  `updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
  CONSTRAINT `gadgets_draft_revision_check` CHECK (`draft_revision` > 0),
  CONSTRAINT `gadgets_published_version_check` CHECK (`published_version` is null or `published_version` > 0)
);
--> statement-breakpoint
CREATE INDEX `gadgets_position_idx` ON `gadgets` (`position`, `created_at`);
--> statement-breakpoint
CREATE TABLE `gadget_versions` (
  `id` text PRIMARY KEY NOT NULL,
  `gadget_id` text NOT NULL,
  `version` integer NOT NULL,
  `name` text NOT NULL,
  `description` text DEFAULT '' NOT NULL,
  `spec_json` text NOT NULL,
  `created_by` text NOT NULL,
  `created_at` text NOT NULL,
  FOREIGN KEY (`gadget_id`) REFERENCES `gadgets`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
  CONSTRAINT `gadget_versions_version_check` CHECK (`version` > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gadget_versions_number_unique` ON `gadget_versions` (`gadget_id`, `version`);
--> statement-breakpoint
CREATE TABLE `gadget_draft_role_access` (
  `gadget_id` text NOT NULL,
  `role_id` text NOT NULL,
  PRIMARY KEY (`gadget_id`, `role_id`),
  FOREIGN KEY (`gadget_id`) REFERENCES `gadgets`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `gadget_draft_role_access_role_idx` ON `gadget_draft_role_access` (`role_id`, `gadget_id`);
--> statement-breakpoint
CREATE TABLE `gadget_version_role_access` (
  `gadget_version_id` text NOT NULL,
  `role_id` text NOT NULL,
  PRIMARY KEY (`gadget_version_id`, `role_id`),
  FOREIGN KEY (`gadget_version_id`) REFERENCES `gadget_versions`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `gadget_version_role_access_role_idx` ON `gadget_version_role_access` (`role_id`, `gadget_version_id`);
--> statement-breakpoint
UPDATE `roles`
SET `permissions_bitmask` = `permissions_bitmask` | 3072
WHERE `key` IN ('owner', 'admin');
