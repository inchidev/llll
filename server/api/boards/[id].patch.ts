import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { taskBoards } from '../../../drizzle/schema'
import { nowIso, WORKSPACE_ID } from '../../../shared/ids'
import { Permission } from '../../../shared/permissions'
import { signalTasksChanged } from '../../../workers/task-events'
import { cf, fail } from '../../utils/cf'
import { getDb } from '../../utils/db'
import { requireMember } from '../../utils/guards'
import { writeAudit } from '../../utils/messages'
import { requireBoard } from '../../utils/task-policy'
import { parseBody } from '../../utils/validate'

const bodySchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  position: z.number().int().min(0).optional(),
  archived: z.boolean().optional(),
}).refine(body => Object.keys(body).length > 0, 'No changes')

export default defineEventHandler(async (event) => {
  const actor = await requireMember(event, WORKSPACE_ID, Permission.manageTasks)
  const id = getRouterParam(event, 'id')!
  const body = parseBody(bodySchema, await readBody(event))
  const { env, waitUntil } = cf(event)
  await requireBoard(env, id)
  const patch: Partial<typeof taskBoards.$inferInsert> = { updatedAt: nowIso() }
  if (body.name !== undefined) patch.name = body.name
  if (body.position !== undefined) patch.position = body.position
  if (body.archived !== undefined) patch.archivedAt = body.archived ? nowIso() : null
  await getDb(env.DB).update(taskBoards).set(patch).where(eq(taskBoards.id, id))
  await writeAudit(env, { workspaceId: WORKSPACE_ID, actorId: actor.user.id, action: body.archived === true ? 'board.archive' : body.archived === false ? 'board.restore' : 'board.update', targetType: 'task_board', targetId: id, meta: { fields: Object.keys(body) } })
  waitUntil(signalTasksChanged(env, id))
  const board = await requireBoard(env, id)
  if (!board) fail(404, 'not_found', 'Board not found')
  return { board }
})
