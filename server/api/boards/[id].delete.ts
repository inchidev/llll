import { eq } from 'drizzle-orm'
import { taskBoards } from '../../../drizzle/schema'
import { WORKSPACE_ID } from '../../../shared/ids'
import { Permission } from '../../../shared/permissions'
import { signalTasksChanged } from '../../../workers/task-events'
import { cf } from '../../utils/cf'
import { getDb } from '../../utils/db'
import { requireMember } from '../../utils/guards'
import { writeAudit } from '../../utils/messages'
import { requireBoard } from '../../utils/task-policy'

export default defineEventHandler(async (event) => {
  const actor = await requireMember(event, WORKSPACE_ID, Permission.manageTasks)
  const id = getRouterParam(event, 'id')!
  const { env, waitUntil } = cf(event)
  const board = await requireBoard(env, id)
  const blobs = await env.DB.prepare(
    'SELECT a.r2_key as r2Key FROM task_attachments a JOIN tasks t ON t.id = a.task_id WHERE t.board_id = ?',
  ).bind(id).all<{ r2Key: string }>()
  await getDb(env.DB).delete(taskBoards).where(eq(taskBoards.id, id))
  if (blobs.results?.length) waitUntil(Promise.all(blobs.results.map(row => env.FILES?.delete(row.r2Key))))
  await writeAudit(env, { workspaceId: WORKSPACE_ID, actorId: actor.user.id, action: 'board.delete', targetType: 'task_board', targetId: id, meta: { name: board.name } })
  waitUntil(signalTasksChanged(env, id))
  return { ok: true }
})
