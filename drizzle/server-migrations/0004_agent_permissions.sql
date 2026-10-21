-- Separate agent use, administration, and approval. No role acquires computer or autonomous execution permissions.
UPDATE roles SET permissions_bitmask = permissions_bitmask | 57344 WHERE (permissions_bitmask & 1) = 1;
--> statement-breakpoint
UPDATE roles SET permissions_bitmask = permissions_bitmask | 1572864 WHERE (permissions_bitmask & 256) = 256;
--> statement-breakpoint
UPDATE roles SET permissions_bitmask = permissions_bitmask | 6291456 WHERE (permissions_bitmask & 512) = 512;
