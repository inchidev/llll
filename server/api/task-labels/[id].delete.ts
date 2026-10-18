import { getServerId } from '../../../shared/server-id'
import { eq } from 'drizzle-orm'
import { taskLabels } from '../../../drizzle/schema'
import { Permission } from '../../../shared/permissions'
import { signalTasksChanged } from '../../../workers/task-events'
import { cf, fail } from '../../utils/cf'
import { getDb } from '../../utils/db'
import { requireMember } from '../../utils/guards'
import { writeAudit } from '../../utils/messages'

export default defineEventHandler(async (event) => {
  const actor = await requireMember(event, (await getServerId(cf(event).env.DB)), Permission.manageTasks)
  const id = getRouterParam(event, 'id')!
  const { env, waitUntil } = cf(event)
  const db = getDb(env.DB)
  const label = (await db.select().from(taskLabels).where(eq(taskLabels.id, id)).limit(1))[0]
  if (!label) fail(404, 'not_found', 'Label not found')
  await db.delete(taskLabels).where(eq(taskLabels.id, id))
  await writeAudit(env, { workspaceId: (await getServerId(cf(event).env.DB)), actorId: actor.user.id, action: 'task_label.delete', targetType: 'task_label', targetId: id, meta: { name: label.name } })
  waitUntil(signalTasksChanged(env, label.boardId))
  return { ok: true }
})
