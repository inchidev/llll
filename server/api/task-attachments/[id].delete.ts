import { eq } from 'drizzle-orm'
import { taskAttachments } from '../../../drizzle/schema'
import { WORKSPACE_ID } from '../../../shared/ids'
import { Permission } from '../../../shared/permissions'
import { signalTasksChanged } from '../../../workers/task-events'
import { cf, requireFiles, fail } from '../../utils/cf'
import { getDb } from '../../utils/db'
import { requireMember } from '../../utils/guards'
import { writeAudit } from '../../utils/messages'
import { requireTask } from '../../utils/task-policy'

export default defineEventHandler(async (event) => {
  const actor = await requireMember(event, WORKSPACE_ID, Permission.manageTasks)
  const id = getRouterParam(event, 'id')!
  const { env, waitUntil } = cf(event)
  const db = getDb(env.DB)
  const attachment = (await db.select().from(taskAttachments).where(eq(taskAttachments.id, id)).limit(1))[0]
  if (!attachment) fail(404, 'not_found', 'Attachment not found')
  const task = await requireTask(env, attachment.taskId)
  await requireFiles(env).delete(attachment.r2Key)
  await db.delete(taskAttachments).where(eq(taskAttachments.id, id))
  await writeAudit(env, { workspaceId: WORKSPACE_ID, actorId: actor.user.id, action: 'task_attachment.delete', targetType: 'task', targetId: task.id, meta: { attachmentId: id, filename: attachment.filename } })
  waitUntil(signalTasksChanged(env, task.boardId, task.id))
  return { ok: true }
})
