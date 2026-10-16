ALTER TABLE `auth_settings` ADD `google_enabled` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `auth_settings` ADD `linkedin_enabled` integer DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE `auth_provider_credentials_next` (
	`provider` text PRIMARY KEY NOT NULL,
	`public_key` text NOT NULL,
	`secret_ciphertext` text NOT NULL,
	`secret_iv` text NOT NULL,
	`secret_version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "auth_provider_credentials_provider_check" CHECK("provider" in ('github', 'google', 'twitter', 'telegram', 'linkedin', 'turnstile'))
);
--> statement-breakpoint
INSERT INTO `auth_provider_credentials_next`
(`provider`, `public_key`, `secret_ciphertext`, `secret_iv`, `secret_version`, `created_at`, `updated_at`)
SELECT `provider`, `public_key`, `secret_ciphertext`, `secret_iv`, `secret_version`, `created_at`, `updated_at`
FROM `auth_provider_credentials`;
--> statement-breakpoint
DROP TABLE `auth_provider_credentials`;
--> statement-breakpoint
ALTER TABLE `auth_provider_credentials_next` RENAME TO `auth_provider_credentials`;
