-- Scheduling huddles is removed until L4 has a calendar. The table stays
-- so the history is kept; schedules that had not started are cancelled so they
-- never become ready if scheduling returns.
UPDATE `scheduled_huddles` SET `status` = 'cancelled', `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `status` IN ('scheduled', 'ready');
