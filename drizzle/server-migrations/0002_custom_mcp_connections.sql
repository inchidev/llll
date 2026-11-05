ALTER TABLE `agent_runs` ADD `private_at` text;--> statement-breakpoint
ALTER TABLE `mcp_outbound_connections` ADD `endpoint` text;--> statement-breakpoint
ALTER TABLE `mcp_outbound_connections` ADD `description` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `mcp_outbound_connections` ADD `auth_kind` text DEFAULT 'none' NOT NULL;
--> statement-breakpoint
UPDATE `mcp_outbound_connections` SET `auth_kind`='bearer' WHERE `credential_json` IS NOT NULL;
