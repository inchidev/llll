CREATE TABLE `backup_destinations` (
	`id` text PRIMARY KEY DEFAULT 'main' NOT NULL,
	`endpoint` text NOT NULL,
	`region` text DEFAULT 'auto' NOT NULL,
	`bucket` text NOT NULL,
	`prefix` text DEFAULT 'llll' NOT NULL,
	`access_key_id` text NOT NULL,
	`secret_access_key_ciphertext` text NOT NULL,
	`secret_access_key_iv` text NOT NULL,
	`secret_access_key_version` integer DEFAULT 1 NOT NULL,
	`last_backup_key` text,
	`last_backup_at` text,
	`last_backup_size_bytes` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "backup_destinations_singleton_check" CHECK("backup_destinations"."id" = 'main')
);
