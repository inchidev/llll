CREATE TABLE `telemetry_settings` (
	`id` text PRIMARY KEY DEFAULT 'main' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "telemetry_settings_singleton_check" CHECK("telemetry_settings"."id" = 'main')
);
--> statement-breakpoint
INSERT INTO `telemetry_settings` (`id`, `enabled`, `updated_at`)
VALUES ('main', true, CURRENT_TIMESTAMP);
