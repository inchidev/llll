CREATE TABLE `auth_provider_credentials` (
	`provider` text PRIMARY KEY NOT NULL,
	`public_key` text NOT NULL,
	`secret_ciphertext` text NOT NULL,
	`secret_iv` text NOT NULL,
	`secret_version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "auth_provider_credentials_provider_check" CHECK("auth_provider_credentials"."provider" in ('github', 'twitter', 'telegram', 'turnstile'))
);
--> statement-breakpoint
CREATE TABLE `auth_settings` (
	`id` text PRIMARY KEY DEFAULT 'main' NOT NULL,
	`registration_mode` text DEFAULT 'invite_only' NOT NULL,
	`email_enabled` integer DEFAULT true NOT NULL,
	`github_enabled` integer DEFAULT false NOT NULL,
	`twitter_enabled` integer DEFAULT false NOT NULL,
	`telegram_enabled` integer DEFAULT false NOT NULL,
	`turnstile_enabled` integer DEFAULT false NOT NULL,
	`email_from` text,
	`email_from_name` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "auth_settings_singleton_check" CHECK("auth_settings"."id" = 'main'),
	CONSTRAINT "auth_settings_registration_mode_check" CHECK("auth_settings"."registration_mode" in ('open', 'invite_only'))
);
