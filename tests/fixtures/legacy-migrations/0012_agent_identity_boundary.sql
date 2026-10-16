PRAGMA defer_foreign_keys = ON;
--> statement-breakpoint
DROP INDEX IF EXISTS `auth_users_email_unique`;
--> statement-breakpoint
ALTER TABLE `auth_users` RENAME TO `identity_keys`;
--> statement-breakpoint
CREATE TABLE `auth_users` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `email` text NOT NULL,
  `email_verified` integer DEFAULT false NOT NULL,
  `image` text,
  `created_at` integer DEFAULT (cast(unixepoch() * 1000 as integer)) NOT NULL,
  `updated_at` integer DEFAULT (cast(unixepoch() * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_users_email_unique` ON `auth_users` (`email`);
--> statement-breakpoint
INSERT INTO `auth_users` (`id`, `name`, `email`, `email_verified`, `image`, `created_at`, `updated_at`)
SELECT `id`, `name`, `email`, `email_verified`, `image`, `created_at`, `updated_at`
FROM `identity_keys`
WHERE `id` NOT IN (SELECT `user_id` FROM `agents`);
--> statement-breakpoint
CREATE TRIGGER `auth_users_identity_key_insert` AFTER INSERT ON `auth_users`
BEGIN
  INSERT OR IGNORE INTO `identity_keys` (`id`, `name`, `email`, `email_verified`, `image`, `created_at`, `updated_at`)
  VALUES (NEW.`id`, NEW.`name`, NEW.`email`, NEW.`email_verified`, NEW.`image`, NEW.`created_at`, NEW.`updated_at`);
END;
--> statement-breakpoint
CREATE TRIGGER `auth_users_identity_key_update` AFTER UPDATE ON `auth_users`
BEGIN
  UPDATE `identity_keys`
  SET `name` = NEW.`name`, `email` = NEW.`email`, `email_verified` = NEW.`email_verified`, `image` = NEW.`image`, `updated_at` = NEW.`updated_at`
  WHERE `id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `auth_users_identity_key_delete` AFTER DELETE ON `auth_users`
BEGIN
  DELETE FROM `identity_keys` WHERE `id` = OLD.`id`;
END;
--> statement-breakpoint
PRAGMA defer_foreign_keys = OFF;
