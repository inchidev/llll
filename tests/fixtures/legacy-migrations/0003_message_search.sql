-- message_search is derived from messages and can be rebuilt from that table.
CREATE VIRTUAL TABLE `message_search` USING fts5(
	`message_id` UNINDEXED,
	`content`,
	tokenize = 'unicode61 remove_diacritics 2'
);
--> statement-breakpoint
INSERT INTO `message_search` (`message_id`, `content`)
SELECT `id`, `content`
FROM `messages`
WHERE `deleted_at` IS NULL AND length(trim(`content`)) > 0;
--> statement-breakpoint
CREATE TRIGGER `message_search_after_insert`
AFTER INSERT ON `messages`
WHEN NEW.`deleted_at` IS NULL AND length(trim(NEW.`content`)) > 0
BEGIN
	INSERT INTO `message_search` (`message_id`, `content`)
	VALUES (NEW.`id`, NEW.`content`);
END;
--> statement-breakpoint
CREATE TRIGGER `message_search_after_update`
AFTER UPDATE OF `content`, `deleted_at` ON `messages`
BEGIN
	DELETE FROM `message_search` WHERE `message_id` = OLD.`id`;
	INSERT INTO `message_search` (`message_id`, `content`)
	SELECT NEW.`id`, NEW.`content`
	WHERE NEW.`deleted_at` IS NULL AND length(trim(NEW.`content`)) > 0;
END;
--> statement-breakpoint
CREATE TRIGGER `message_search_after_delete`
AFTER DELETE ON `messages`
BEGIN
	DELETE FROM `message_search` WHERE `message_id` = OLD.`id`;
END;
