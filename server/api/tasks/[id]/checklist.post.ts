import { z } from 'zod'
import { taskChecklistItems } from '../../../../drizzle/schema'
import { newId, nowIso, WORKSPACE_ID } from '../../../../shared/ids'
import { Permission } from '../../../../shared/permissions'
import { signalTasksChanged } from '../../../../workers/task-events'
import { cf } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import { requireMember } from '../../../utils/guards'
import { writeAudit } from '../../../utils/messages'
import { requireTask } from '../../../utils/task-policy'
import { parseBody } from '../../../utils/validate'

const bodySchema = z.object({ title: z.string().trim().min(1).max(240), position: z.number().int().min(0).optional() })

export default defineEventHandler(async (event) => {
  const actor = await requireMember(event, WORKSPACE_ID, Permission.manageTasks)
  const taskReference = getRouterParam(event, 'id')!
  const body = parseBody(bodySchema, await readBody(event))
  const { env, waitUntil } = cf(event)
  const task = await requireTask(env, taskReference)
  const taskId = task.id
  const now = nowIso()
  const id = newId()
  const position = body.position ?? Date.now()
  const item = { id, taskId, title: body.title, completed: false, position, createdBy: actor.user.id, createdAt: now, updatedAt: now }
  await getDb(env.DB).insert(taskChecklistItems).values(item)
  await writeAudit(env, { workspaceId: WORKSPACE_ID, actorId: actor.user.id, action: 'task_checklist.create', targetType: 'task', targetId: taskId, meta: { itemId: id } })
  waitUntil(signalTasksChanged(env, task.boardId, taskId))
  return { item }
})
