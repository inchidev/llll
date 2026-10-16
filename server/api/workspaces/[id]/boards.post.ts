import { z } from 'zod'
import { taskBoards } from '../../../../drizzle/schema'
import { newId, nowIso } from '../../../../shared/ids'
import { Permission } from '../../../../shared/permissions'
import { signalTasksChanged } from '../../../../workers/task-events'
import { requireMember } from '../../../utils/guards'
import { cf } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import { writeAudit } from '../../../utils/messages'
import { parseBody } from '../../../utils/validate'
import { nextBoardPosition } from '../../../utils/task-policy'

const bodySchema = z.object({ name: z.string().trim().min(1).max(80) })

export default defineEventHandler(async (event) => {
  const workspaceId = getRouterParam(event, 'id')!
  const actor = await requireMember(event, workspaceId, Permission.manageTasks)
  const body = parseBody(bodySchema, await readBody(event))
  const { env, waitUntil } = cf(event)
  const id = newId()
  const now = nowIso()
  const board = { id, name: body.name, position: await nextBoardPosition(env), createdBy: actor.user.id, archivedAt: null, createdAt: now, updatedAt: now }
  await getDb(env.DB).insert(taskBoards).values(board)
  await writeAudit(env, { workspaceId, actorId: actor.user.id, action: 'board.create', targetType: 'task_board', targetId: id, meta: { name: body.name } })
  waitUntil(signalTasksChanged(env, id))
  return { board: { ...board, labels: [], tasks: [] } }
})
