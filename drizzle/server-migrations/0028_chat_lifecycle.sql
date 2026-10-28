-- One 1:1 DM per pair: a canonical, ordered participant key with a unique index.
ALTER TABLE channels ADD COLUMN dm_pair_key TEXT;
--> statement-breakpoint
UPDATE channels SET dm_pair_key = (SELECT MIN(user_id) || ':' || MAX(user_id) FROM channel_members WHERE channel_id = channels.id)
WHERE type = 'dm' AND dm_kind = 'pair' AND (SELECT COUNT(*) FROM channel_members WHERE channel_id = channels.id) = 2;
--> statement-breakpoint
-- Earlier duplicates keep their history; only the oldest DM of a pair holds the key and is reopened.
UPDATE channels SET dm_pair_key = NULL
WHERE dm_pair_key IS NOT NULL AND EXISTS (
  SELECT 1 FROM channels older WHERE older.dm_pair_key = channels.dm_pair_key
    AND (older.created_at < channels.created_at OR (older.created_at = channels.created_at AND older.id < channels.id))
);
--> statement-breakpoint
CREATE UNIQUE INDEX channels_dm_pair_key_unique ON channels(dm_pair_key) WHERE dm_pair_key IS NOT NULL;
