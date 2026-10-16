import { eq } from 'drizzle-orm'
import { taskAttachments, tasks } from '../../../drizzle/schema'
import { WORKSPACE_ID } from '../../../shared/ids'
import { Permission } from '../../../shared/permissions'
import { signalTasksChanged } from '../../../workers/task-events'
import { cf } from '../../utils/cf'
import { getDb } from '../../utils/db'
import { requireMember } from '../../utils/guards'
import { writeAudit } from '../../utils/messages'
import { requireTask } from '../../utils/task-policy'

export default defineEventHandler(async (event) => {
  const actor = await requireMember(event, WORKSPACE_ID, Permission.manageTasks)
  const id = getRouterParam(event, 'id')!
  const { env, waitUntil } = cf(event)
  const db = getDb(env.DB)
  const task = await requireTask(env, id)
  const taskId = task.id
  const attachments = await db.select({ r2Key: taskAttachments.r2Key }).from(taskAttachments).where(eq(taskAttachments.taskId, taskId))
  await db.delete(tasks).where(eq(tasks.id, taskId))
  await writeAudit(env, { workspaceId: WORKSPACE_ID, actorId: actor.user.id, action: 'task.delete', targetType: 'task', targetId: taskId, meta: { boardId: task.boardId, title: task.title } })
  if (attachments.length) waitUntil(Promise.all(attachments.map(item => env.FILES?.delete(item.r2Key))))
  waitUntil(signalTasksChanged(env, task.boardId, taskId))
  return { ok: true }
})
