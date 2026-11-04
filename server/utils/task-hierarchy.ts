import { Permission } from '../../shared/permissions'
import type { AuthorizationContext } from '../../shared/authorization'
import type { L4Env } from '../../workers/env'
import { fail } from './cf'
import { requireTask } from './task-policy'

/** Check the proposed edge and both ends of a move, including archived descendants. */
export async function validateTaskHierarchy(
  env: L4Env, auth: AuthorizationContext,
  task: { id?: string; boardId: string; projectId: string | null; parentTaskId: string | null },
  changingParent: boolean,
) {
  if (task.parentTaskId) {
    const parent = await requireTask(env, task.parentTaskId, auth, changingParent ? Permission.writeTasks : Permission.readTasks)
    if (parent.boardId !== task.boardId || parent.projectId !== task.projectId) fail(400, 'task_hierarchy', 'Parent and subtask must be on the same board and in the same Project')
    if (changingParent && parent.archivedAt) fail(400, 'task_hierarchy', 'Restore the parent before adding subtasks')
    if (task.id) {
      const cycle = await env.DB.prepare(`WITH RECURSIVE ancestors(id) AS (
        SELECT ? UNION SELECT t.parent_task_id FROM tasks t JOIN ancestors a ON t.id=a.id WHERE t.parent_task_id IS NOT NULL
      ) SELECT 1 AS found FROM ancestors WHERE id=?`).bind(task.parentTaskId, task.id).first()
      if (cycle) fail(400, 'task_hierarchy', 'A task cannot be its own parent or a descendant’s subtask')
    }
  }
  if (task.id) {
    const outside = await env.DB.prepare('SELECT 1 AS found FROM tasks WHERE parent_task_id=? AND (board_id<>? OR project_id IS NOT ?) LIMIT 1')
      .bind(task.id, task.boardId, task.projectId).first()
    if (outside) fail(400, 'task_hierarchy', 'Detach subtasks before moving their parent to another board or Project')
  }
}

/** SQLite enforces these invariants again at write time, including competing edits. */
export async function hierarchyWrite<T>(write: () => Promise<T>): Promise<T> {
  try { return await write() }
  catch (error) {
    // Drizzle may wrap the SQLite failure in a query error.
    let cause: unknown = error
    for (let depth = 0; cause && depth < 5; depth++) {
      if (String(cause).includes('task_hierarchy')) fail(409, 'task_hierarchy', 'The task hierarchy changed. Reload and check the parent, board and Project.')
      cause = cause instanceof Error ? cause.cause : undefined
    }
    throw error
  }
}
