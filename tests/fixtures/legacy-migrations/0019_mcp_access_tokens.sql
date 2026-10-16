CREATE TABLE `mcp_access_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`token_prefix` text NOT NULL,
	`scopes_json` text NOT NULL,
	`created_by` text NOT NULL,
	`last_used_at` text,
	`revoked_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_access_tokens_hash_unique` ON `mcp_access_tokens` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `mcp_access_tokens_created_by_idx` ON `mcp_access_tokens` (`created_by`);
--> statement-breakpoint
CREATE INDEX `mcp_access_tokens_active_idx` ON `mcp_access_tokens` (`revoked_at`,`created_at`);
