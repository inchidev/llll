CREATE TABLE `realtimekit_settings` (
	`id` text PRIMARY KEY DEFAULT 'main' NOT NULL,
	`account_id` text NOT NULL,
	`app_id` text NOT NULL,
	`api_token_ciphertext` text NOT NULL,
	`api_token_iv` text NOT NULL,
	`api_token_version` integer DEFAULT 1 NOT NULL,
	`voice_preset` text DEFAULT 'voice' NOT NULL,
	`av_preset` text DEFAULT 'group_call_host' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "realtimekit_settings_singleton_check" CHECK("realtimekit_settings"."id" = 'main')
);
