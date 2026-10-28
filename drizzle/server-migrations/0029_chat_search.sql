-- Unread counts, unread probes and server-wide search seek surviving messages
-- by conversation and id instead of scanning a conversation's whole history.
CREATE INDEX `messages_live_channel_id_idx` ON `messages` (`channel_id`,`id`) WHERE `deleted_at` IS NULL;
