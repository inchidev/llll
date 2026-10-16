CREATE TABLE `channel_role_overrides` (
	`channel_id` text NOT NULL,
	`role_id` text NOT NULL,
	`allow_mask` integer DEFAULT 0 NOT NULL,
	`deny_mask` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`channel_id`, `role_id`),
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `channel_role_overrides_allow_check` CHECK((`allow_mask` & ~112) = 0),
	CONSTRAINT `channel_role_overrides_deny_check` CHECK((`deny_mask` & ~112) = 0),
	CONSTRAINT `channel_role_overrides_disjoint_check` CHECK((`allow_mask` & `deny_mask`) = 0)
);
--> statement-breakpoint
CREATE INDEX `channel_role_overrides_role_id_idx` ON `channel_role_overrides` (`role_id`);
