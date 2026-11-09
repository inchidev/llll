CREATE TABLE `cloud_relay_requests` (
	`action` text NOT NULL,
	`request_id` text NOT NULL,
	`answer_json` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`action`, `request_id`)
);
--> statement-breakpoint
CREATE INDEX `cloud_relay_requests_created_idx` ON `cloud_relay_requests` (`created_at`);