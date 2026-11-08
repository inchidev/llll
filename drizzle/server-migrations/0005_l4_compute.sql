CREATE TABLE `l4_compute_link` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`account` text NOT NULL,
	`token_ciphertext` text NOT NULL,
	`token_iv` text NOT NULL,
	`token_version` integer DEFAULT 1 NOT NULL,
	`linked_by` text NOT NULL,
	`linked_at` text NOT NULL,
	FOREIGN KEY (`linked_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "l4_compute_link_singleton_check" CHECK("l4_compute_link"."singleton" = 1)
);
--> statement-breakpoint
ALTER TABLE `compute_nodes` ADD `placement_id` text REFERENCES compute_nodes(id);--> statement-breakpoint
ALTER TABLE `compute_nodes` ADD `box_id` text;--> statement-breakpoint
CREATE INDEX `compute_nodes_placement` ON `compute_nodes` (`placement_id`);--> statement-breakpoint
ALTER TABLE `compute_pairings` ADD `box_id` text;--> statement-breakpoint
ALTER TABLE `factory_boxes` ADD `cloud_box_id` text;--> statement-breakpoint
ALTER TABLE `factory_boxes` ADD `cloud_size` text;