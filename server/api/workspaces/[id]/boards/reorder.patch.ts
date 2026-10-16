import { isNull } from 'drizzle-orm'
import { z } from 'zod'
import { taskBoards } from '../../../../../drizzle/schema'
import { nowIso } from '../../../../../shared/ids'
import { Permission } from '../../../../../shared/permissions'
import { signalTasksChanged } from '../../../../../workers/task-events'
import { cf, fail } from '../../../../utils/cf'
import { getDb } from '../../../../utils/db'
import { requireMember } from '../../../../utils/guards'
import { writeAudit } from '../../../../utils/messages'
import { parseBody } from '../../../../utils/validate'

const bodySchema = z.object({ boardIds: z.array(z.string().min(8)).min(1).max(100) })

export default defineEventHandler(async (event) => {
  const workspaceId = getRouterParam(event, 'id')!
  const actor = await requireMember(event, workspaceId, Permission.manageTasks)
  const body = parseBody(bodySchema, await readBody(event))
  if (new Set(body.boardIds).size !== body.boardIds.length) fail(400, 'bad_request', 'Board ids must be unique')
  const { env, waitUntil } = cf(event)
  const existing = await getDb(env.DB).select({ id: taskBoards.id }).from(taskBoards).where(isNull(taskBoards.archivedAt))
  if (existing.length !== body.boardIds.length || existing.some(row => !body.boardIds.includes(row.id))) {
    fail(400, 'bad_request', 'Provide every active board exactly once')
  }
  const now = nowIso()
  await env.DB.batch(body.boardIds.map((id, index) => env.DB.prepare(
    'UPDATE task_boards SET position = ?, updated_at = ? WHERE id = ?',
  ).bind((index + 1) * 1024, now, id)))
  await writeAudit(env, { workspaceId, actorId: actor.user.id, action: 'board.reorder', targetType: 'task_board', targetId: workspaceId })
  waitUntil(signalTasksChanged(env, null))
  return { ok: true }
})
