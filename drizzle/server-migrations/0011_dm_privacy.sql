-- Preserve pair privacy even when a group later shrinks to two participants.
ALTER TABLE channels ADD COLUMN dm_kind TEXT NOT NULL DEFAULT 'pair' CHECK (dm_kind IN ('pair', 'group'));
--> statement-breakpoint
ALTER TABLE channels ADD COLUMN dm_owner_id TEXT REFERENCES users(id) ON DELETE SET NULL;
--> statement-breakpoint
UPDATE channels SET dm_kind = 'group'
WHERE type = 'dm' AND (SELECT COUNT(*) FROM channel_members WHERE channel_id = channels.id) > 2;
-- Historical group creators were not recorded. Leave these groups unowned:
-- members can leave, but no arbitrary participant gains power to remove others.
