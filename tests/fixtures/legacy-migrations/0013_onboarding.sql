CREATE TABLE `onboarding_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`privacy_json` text NOT NULL,
	`terms_json` text NOT NULL,
	`rules_json` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `identity_keys`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `onboarding_revisions_version_unique` ON `onboarding_revisions` (`version`);
--> statement-breakpoint
CREATE TABLE `onboarding_acceptances` (
	`user_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`accepted_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `revision_id`),
	FOREIGN KEY (`user_id`) REFERENCES `identity_keys`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`revision_id`) REFERENCES `onboarding_revisions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `onboarding_acceptances_revision_idx` ON `onboarding_acceptances` (`revision_id`);
