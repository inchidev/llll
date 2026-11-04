ALTER TABLE `tasks` ADD `parent_task_id` text REFERENCES tasks(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `tasks_parent_idx` ON `tasks` (`parent_task_id`);
--> statement-breakpoint
CREATE TRIGGER tasks_hierarchy_insert BEFORE INSERT ON tasks
BEGIN
  SELECT RAISE(ABORT, 'task_hierarchy_boundary') WHERE NEW.parent_task_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM tasks p WHERE p.id=NEW.parent_task_id AND p.board_id=NEW.board_id AND p.project_id IS NEW.project_id
  );
  SELECT RAISE(ABORT, 'task_hierarchy_cycle') WHERE NEW.parent_task_id IS NOT NULL AND EXISTS (
    WITH RECURSIVE ancestors(id) AS (
      SELECT NEW.parent_task_id UNION SELECT t.parent_task_id FROM tasks t JOIN ancestors a ON t.id=a.id WHERE t.parent_task_id IS NOT NULL
    ) SELECT 1 FROM ancestors WHERE id=NEW.id
  );
  SELECT RAISE(ABORT, 'task_hierarchy_archived') WHERE EXISTS (
    SELECT 1 FROM tasks p WHERE p.id=NEW.parent_task_id AND p.archived_at IS NOT NULL
  );
END;

--> statement-breakpoint
CREATE TRIGGER tasks_hierarchy_update BEFORE UPDATE OF parent_task_id, board_id, project_id ON tasks
BEGIN
  SELECT RAISE(ABORT, 'task_hierarchy_boundary') WHERE NEW.parent_task_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM tasks p WHERE p.id=NEW.parent_task_id AND p.board_id=NEW.board_id AND p.project_id IS NEW.project_id
  );
  SELECT RAISE(ABORT, 'task_hierarchy_cycle') WHERE NEW.parent_task_id IS NOT NULL AND EXISTS (
    WITH RECURSIVE ancestors(id) AS (
      SELECT NEW.parent_task_id UNION SELECT t.parent_task_id FROM tasks t JOIN ancestors a ON t.id=a.id WHERE t.parent_task_id IS NOT NULL
    ) SELECT 1 FROM ancestors WHERE id=NEW.id
  );
  SELECT RAISE(ABORT, 'task_hierarchy_children') WHERE EXISTS (
    SELECT 1 FROM tasks c WHERE c.parent_task_id=NEW.id AND (c.board_id<>NEW.board_id OR c.project_id IS NOT NEW.project_id)
  );
  SELECT RAISE(ABORT, 'task_hierarchy_archived') WHERE NEW.parent_task_id IS NOT OLD.parent_task_id AND EXISTS (
    SELECT 1 FROM tasks p WHERE p.id=NEW.parent_task_id AND p.archived_at IS NOT NULL
  );
END;
