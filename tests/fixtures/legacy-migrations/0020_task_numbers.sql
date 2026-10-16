CREATE TABLE `task_numbers` (
	`task_id` text PRIMARY KEY NOT NULL,
	`number` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_numbers_number_unique` ON `task_numbers` (`number`);
--> statement-breakpoint
CREATE TABLE `task_number_sequence` (
	`id` integer PRIMARY KEY NOT NULL,
	`next_number` integer NOT NULL,
	CONSTRAINT `task_number_sequence_singleton_check` CHECK (`id` = 1),
	CONSTRAINT `task_number_sequence_next_check` CHECK (`next_number` > 0)
);
--> statement-breakpoint
WITH `candidates` AS (
	SELECT
		`id` AS `task_id`,
		CASE
			WHEN instr(`title`, ' — ') > 1
				AND substr(`title`, 1, instr(`title`, ' — ') - 1) NOT GLOB '*[^0-9]*'
				AND CAST(substr(`title`, 1, instr(`title`, ' — ') - 1) AS integer) > 0
				AND CAST(substr(`title`, 1, instr(`title`, ' — ') - 1) AS integer) <= 2147483647
			THEN CAST(substr(`title`, 1, instr(`title`, ' — ') - 1) AS integer)
		END AS `candidate`
	FROM `tasks`
),
`unique_candidates` AS (
	SELECT `task_id`, `candidate`
	FROM `candidates` AS `candidate_row`
	WHERE `candidate` IS NOT NULL
		AND (SELECT count(*) FROM `candidates` WHERE `candidate` = `candidate_row`.`candidate`) = 1
)
INSERT INTO `task_numbers` (`task_id`, `number`)
SELECT `task_id`, `candidate` FROM `unique_candidates`;
--> statement-breakpoint
WITH `base` AS (
	SELECT max(1000, coalesce(max(`number`), 1000)) AS `number` FROM `task_numbers`
),
`unnumbered` AS (
	SELECT `tasks`.`id` AS `task_id`, row_number() OVER (ORDER BY `tasks`.`created_at`, `tasks`.`id`) AS `offset`
	FROM `tasks`
	LEFT JOIN `task_numbers` ON `task_numbers`.`task_id` = `tasks`.`id`
	WHERE `task_numbers`.`task_id` IS NULL
)
INSERT INTO `task_numbers` (`task_id`, `number`)
SELECT `task_id`, `base`.`number` + `offset` FROM `unnumbered`, `base`;
--> statement-breakpoint
INSERT INTO `task_number_sequence` (`id`, `next_number`)
SELECT 1, max(1001, coalesce(max(`number`) + 1, 1001)) FROM `task_numbers`;
--> statement-breakpoint
CREATE TRIGGER `tasks_assign_number_after_insert`
AFTER INSERT ON `tasks`
WHEN NOT EXISTS (SELECT 1 FROM `task_numbers` WHERE `task_id` = NEW.`id`)
BEGIN
	INSERT INTO `task_numbers` (`task_id`, `number`)
	SELECT NEW.`id`, `next_number` FROM `task_number_sequence` WHERE `id` = 1;
	UPDATE `task_number_sequence` SET `next_number` = `next_number` + 1 WHERE `id` = 1;
END;
