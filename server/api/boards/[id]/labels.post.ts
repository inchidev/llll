import { z } from 'zod'
import { taskLabels } from '../../../../drizzle/schema'
import { newId, nowIso, WORKSPACE_ID } from '../../../../shared/ids'
import { Permission } from '../../../../shared/permissions'
import { signalTasksChanged } from '../../../../workers/task-events'
import { cf } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import { requireMember } from '../../../utils/guards'
import { writeAudit } from '../../../utils/messages'
import { nextLabelPosition, requireBoard } from '../../../utils/task-policy'
import { parseBody } from '../../../utils/validate'

const colors = ['neutral', 'primary', 'info', 'success', 'warning', 'error'] as const
const bodySchema = z.object({ name: z.string().trim().min(1).max(40), color: z.enum(colors).default('neutral') })

export default defineEventHandler(async (event) => {
  const actor = await requireMember(event, WORKSPACE_ID, Permission.manageTasks)
  const boardId = getRouterParam(event, 'id')!
  const body = parseBody(bodySchema, await readBody(event))
  const { env, waitUntil } = cf(event)
  await requireBoard(env, boardId)
  const now = nowIso()
  const label = { id: newId(), boardId, name: body.name, color: body.color, position: await nextLabelPosition(env, boardId), createdBy: actor.user.id, createdAt: now, updatedAt: now }
  try {
    await getDb(env.DB).insert(taskLabels).values(label)
  }
  catch {
    throw createError({ statusCode: 409, statusMessage: 'A label with that name already exists' })
  }
  await writeAudit(env, { workspaceId: WORKSPACE_ID, actorId: actor.user.id, action: 'task_label.create', targetType: 'task_label', targetId: label.id, meta: { boardId, name: label.name } })
  waitUntil(signalTasksChanged(env, boardId))
  return { label }
})
