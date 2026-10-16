UPDATE `roles`
SET `permissions_bitmask` = `permissions_bitmask` & ~256
WHERE `key` NOT IN ('owner', 'admin');
--> statement-breakpoint
UPDATE `roles`
SET `permissions_bitmask` = `permissions_bitmask` | 256
WHERE `key` IN ('owner', 'admin');
