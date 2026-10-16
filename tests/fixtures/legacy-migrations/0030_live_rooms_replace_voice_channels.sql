-- Every text Channel and Direct Message has its own Live room, so voice-only
-- Channels are retired. Existing ones keep their messages as text Channels.
-- The stored CHECK constraint still accepts 'voice'; nothing writes it anymore.
UPDATE `channels` SET `type` = 'text', `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `type` = 'voice';
--> statement-breakpoint
-- RealtimeKit presets are now split by role: hosts can moderate, participants
-- cannot. Existing settings used one preset for everyone, so both start as that
-- preset until the owner reconnects and L4 provisions its own pair.
UPDATE `realtimekit_settings` SET `voice_preset` = `av_preset`;
--> statement-breakpoint
ALTER TABLE `realtimekit_settings` RENAME COLUMN `av_preset` TO `host_preset`;
--> statement-breakpoint
ALTER TABLE `realtimekit_settings` RENAME COLUMN `voice_preset` TO `participant_preset`;
