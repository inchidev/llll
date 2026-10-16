import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { taskLabels } from '../../../drizzle/schema'
import { nowIso, WORKSPACE_ID } from '../../../shared/ids'
import { Permission } from '../../../shared/permissions'
import { signalTasksChanged } from '../../../workers/task-events'
import { cf, fail } from '../../utils/cf'
import { getDb } from '../../utils/db'
import { requireMember } from '../../utils/guards'
import { writeAudit } from '../../utils/messages'
import { parseBody } from '../../utils/validate'

const bodySchema = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  color: z.enum(['neutral', 'primary', 'info', 'success', 'warning', 'error']).optional(),
  position: z.number().int().min(0).optional(),
}).refine(body => Object.keys(body).length > 0, 'No changes')

export default defineEventHandler(async (event) => {
  const actor = await requireMember(event, WORKSPACE_ID, Permission.manageTasks)
  const id = getRouterParam(event, 'id')!
  const body = parseBody(bodySchema, await readBody(event))
  const { env, waitUntil } = cf(event)
  const db = getDb(env.DB)
  const label = (await db.select().from(taskLabels).where(eq(taskLabels.id, id)).limit(1))[0]
  if (!label) fail(404, 'not_found', 'Label not found')
  await db.update(taskLabels).set({ ...body, updatedAt: nowIso() }).where(eq(taskLabels.id, id))
  await writeAudit(env, { workspaceId: WORKSPACE_ID, actorId: actor.user.id, action: 'task_label.update', targetType: 'task_label', targetId: id, meta: { fields: Object.keys(body) } })
  waitUntil(signalTasksChanged(env, label.boardId))
  return { ok: true }
})
