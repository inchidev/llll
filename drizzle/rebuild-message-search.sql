-- message_search contains derived data only. It is safe to drop before a D1
-- export (which cannot include virtual tables), then run this after restore.
DROP TRIGGER IF EXISTS `message_search_after_insert`;
DROP TRIGGER IF EXISTS `message_search_after_update`;
DROP TRIGGER IF EXISTS `message_search_after_delete`;
DROP TABLE IF EXISTS `message_search`;
CREATE VIRTUAL TABLE `message_search` USING fts5(
	`message_id` UNINDEXED,
	`content`,
	tokenize = 'unicode61 remove_diacritics 2'
);
INSERT INTO `message_search` (`message_id`, `content`)
SELECT `id`, `content`
FROM `messages`
WHERE `deleted_at` IS NULL AND length(trim(`content`)) > 0;
CREATE TRIGGER `message_search_after_insert`
AFTER INSERT ON `messages`
WHEN NEW.`deleted_at` IS NULL AND length(trim(NEW.`content`)) > 0
BEGIN
	INSERT INTO `message_search` (`message_id`, `content`)
	VALUES (NEW.`id`, NEW.`content`);
END;
CREATE TRIGGER `message_search_after_update`
AFTER UPDATE OF `content`, `deleted_at` ON `messages`
BEGIN
	DELETE FROM `message_search` WHERE `message_id` = OLD.`id`;
	INSERT INTO `message_search` (`message_id`, `content`)
	SELECT NEW.`id`, NEW.`content`
	WHERE NEW.`deleted_at` IS NULL AND length(trim(NEW.`content`)) > 0;
END;
CREATE TRIGGER `message_search_after_delete`
AFTER DELETE ON `messages`
BEGIN
	DELETE FROM `message_search` WHERE `message_id` = OLD.`id`;
END;
INSERT INTO `message_search` (`message_search`) VALUES ('optimize');
