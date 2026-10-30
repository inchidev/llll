-- A push subscription can also be a Telegram delivery target. Its relay (the Shell origin) holds the
-- bot; the Server keeps only an opaque token for one Telegram chat, never the Telegram ID.
ALTER TABLE `push_subscriptions` ADD `transport` text DEFAULT 'webpush' NOT NULL CHECK(`transport` in ('webpush', 'telegram'));
--> statement-breakpoint
ALTER TABLE `push_subscriptions` ADD `relay_origin` text;
--> statement-breakpoint
ALTER TABLE `push_subscriptions` ADD `relay_token` text;
