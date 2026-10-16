import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { taskChecklistItems } from '../../../drizzle/schema'
import { nowIso, WORKSPACE_ID } from '../../../shared/ids'
import { Permission } from '../../../shared/permissions'
import { signalTasksChanged } from '../../../workers/task-events'
import { cf, fail } from '../../utils/cf'
import { getDb } from '../../utils/db'
import { requireMember } from '../../utils/guards'
import { writeAudit } from '../../utils/messages'
import { requireTask } from '../../utils/task-policy'
import { parseBody } from '../../utils/validate'

const bodySchema = z.object({
  title: z.string().trim().min(1).max(240).optional(),
  completed: z.boolean().optional(),
  position: z.number().int().min(0).optional(),
}).refine(body => Object.keys(body).length > 0, 'No changes')

export default defineEventHandler(async (event) => {
  const actor = await requireMember(event, WORKSPACE_ID, Permission.manageTasks)
  const id = getRouterParam(event, 'id')!
  const body = parseBody(bodySchema, await readBody(event))
  const { env, waitUntil } = cf(event)
  const db = getDb(env.DB)
  const item = (await db.select().from(taskChecklistItems).where(eq(taskChecklistItems.id, id)).limit(1))[0]
  if (!item) fail(404, 'not_found', 'Checklist item not found')
  const task = await requireTask(env, item.taskId)
  await db.update(taskChecklistItems).set({ ...body, updatedAt: nowIso() }).where(eq(taskChecklistItems.id, id))
  await writeAudit(env, { workspaceId: WORKSPACE_ID, actorId: actor.user.id, action: 'task_checklist.update', targetType: 'task', targetId: task.id, meta: { itemId: id, fields: Object.keys(body) } })
  waitUntil(signalTasksChanged(env, task.boardId, task.id))
  return { ok: true }
})
