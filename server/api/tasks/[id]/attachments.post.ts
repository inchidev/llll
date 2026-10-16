import { taskAttachments } from '../../../../drizzle/schema'
import { newId, nowIso, WORKSPACE_ID } from '../../../../shared/ids'
import { MAX_ATTACHMENT_BYTES, sniffMime } from '../../../../shared/mime'
import { hasPermission, Permission } from '../../../../shared/permissions'
import { signalTasksChanged } from '../../../../workers/task-events'
import { cf, requireFiles, fail } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import { requireMember } from '../../../utils/guards'
import { writeAudit } from '../../../utils/messages'
import { requireTask } from '../../../utils/task-policy'

export default defineEventHandler(async (event) => {
  const actor = await requireMember(event, WORKSPACE_ID, Permission.manageTasks)
  if (!hasPermission(actor.perms, Permission.attachFiles)) fail(403, 'forbidden', 'Missing attach-files permission')
  const taskReference = getRouterParam(event, 'id')!
  const { env, waitUntil } = cf(event)
  const task = await requireTask(env, taskReference)
  const taskId = task.id
  const form = await readMultipartFormData(event)
  const file = form?.find(part => part.name === 'file' && part.data)
  if (!file?.data) fail(400, 'bad_request', 'Missing file')
  if (file.data.byteLength > MAX_ATTACHMENT_BYTES) fail(413, 'too_large', 'File exceeds 10 MB')
  const mime = sniffMime(file.data, file.filename || 'file')
  if (!mime) fail(415, 'unsupported_type', 'File type not allowed')
  const id = newId()
  const safeName = (file.filename || 'file').replace(/[^\w.-]+/g, '_').slice(0, 80)
  const key = `${WORKSPACE_ID}/tasks/${taskId}/${id}-${safeName}`
  await requireFiles(env).put(key, file.data, { httpMetadata: { contentType: mime } })
  const row = { id, taskId, uploaderId: actor.user.id, r2Key: key, filename: safeName, contentType: mime, sizeBytes: file.data.byteLength, width: null, height: null, createdAt: nowIso() }
  try {
    await getDb(env.DB).insert(taskAttachments).values(row)
  }
  catch (error) {
    await requireFiles(env).delete(key)
    throw error
  }
  await writeAudit(env, { workspaceId: WORKSPACE_ID, actorId: actor.user.id, action: 'task_attachment.create', targetType: 'task', targetId: taskId, meta: { attachmentId: id, filename: safeName } })
  waitUntil(signalTasksChanged(env, task.boardId, taskId))
  return { attachment: { id, taskId, uploaderId: actor.user.id, filename: safeName, contentType: mime, sizeBytes: file.data.byteLength, width: null, height: null, createdAt: row.createdAt, url: `/api/task-files/${id}` } }
})
