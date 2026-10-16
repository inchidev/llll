UPDATE `tasks`
SET `status` = coalesce(
      (SELECT `task_status_before` FROM `task_runs` WHERE `id` = `tasks`.`active_run_id`),
      CASE WHEN `assignee_id` IS NULL THEN 'backlog' ELSE 'ready' END
    ),
    `active_run_id` = NULL,
    `updated_at` = CURRENT_TIMESTAMP
WHERE `status` = 'running';
--> statement-breakpoint
UPDATE `task_runs`
SET `status` = 'cancelled',
    `progress` = NULL,
    `approval_json` = NULL,
    `cancelled_at` = coalesce(`cancelled_at`, CURRENT_TIMESTAMP),
    `error` = coalesce(`error`, 'Task execution was retired in L4 0.1.5')
WHERE `status` IN ('queued', 'running');
