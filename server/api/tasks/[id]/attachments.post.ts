import { spaceOfResource } from '../../../utils/space-access'
import { requireStorageQuota } from '../../../utils/space-quota'
import { getServerId } from '../../../../shared/server-id'
import { taskAttachments } from '../../../../drizzle/schema'
import { newId, nowIso } from '../../../../shared/ids'
import { MAX_ATTACHMENT_BYTES, sniffMime } from '../../../../shared/mime'
import { RECORDING_MAX_FRAMES, recordingFrameSchema } from '../../../../shared/task-recordings'
import { parseBody } from '../../../utils/validate'
import { hasPermission, Permission } from '../../../../shared/permissions'
import { signalTasksChanged } from '../../../../workers/task-events'
import { cf, requireFiles, fail } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import { requireMember } from '../../../utils/guards'
import { writeAudit } from '../../../utils/messages'
import { requireTask } from '../../../utils/task-policy'

export default defineEventHandler(async (event) => {
  const actor = await requireMember(event, (await getServerId(cf(event).env.DB)))
  if (!hasPermission(actor.perms, Permission.attachFiles)) fail(403, 'forbidden', 'Missing attach-files permission')
  const taskReference = getRouterParam(event, 'id')!
  const { env, waitUntil } = cf(event)
  const task = await requireTask(env, taskReference, actor.authorization, Permission.writeTasks)
  const taskId = task.id
  const form = await readMultipartFormData(event)
  const file = form?.find(part => part.name === 'file' && part.data)
  if (!file?.data) fail(400, 'bad_request', 'Missing file')
  if (file.data.byteLength > MAX_ATTACHMENT_BYTES) fail(413, 'too_large', 'File exceeds 10 MB')
  const mime = sniffMime(file.data, file.filename || 'file')
  if (!mime) fail(415, 'unsupported_type', 'File type not allowed')
  const taskSpaceId = await spaceOfResource(env, 'task', taskId)
  if (taskSpaceId) await requireStorageQuota(env, taskSpaceId, file.data.byteLength)
  // A frame cut from this Task's recording, with where it comes from.
  const sourceId = form?.find(part => part.name === 'sourceId')?.data.toString() || null
  const frameMarks = form?.find(part => part.name === 'frame')?.data.toString()
  if (sourceId) {
    const source = await env.DB.prepare("SELECT 1 AS ok FROM task_attachments WHERE id=? AND task_id=? AND role='recording'").bind(sourceId, taskId).first()
    if (!source || mime !== 'image/jpeg') fail(400, 'bad_request', 'A frame is a JPEG of a recording on this Task')
    const frames = await env.DB.prepare('SELECT count(*) AS n FROM task_attachments WHERE source_id=?').bind(sourceId).first<{ n: number }>()
    if ((frames?.n ?? 0) >= RECORDING_MAX_FRAMES) fail(400, 'bad_request', 'This recording has all its frames')
  }
  const marks = sourceId ? parseBody(recordingFrameSchema, JSON.parse(frameMarks || 'null')) : null
  const id = newId()
  const safeName = (file.filename || 'file').replace(/[^\w.-]+/g, '_').slice(0, 80)
  const key = `${(await getServerId(cf(event).env.DB))}/tasks/${taskId}/${id}-${safeName}`
  await requireFiles(env).put(key, file.data, { httpMetadata: { contentType: mime } })
  const row = { id, taskId, uploaderId: actor.user.id, r2Key: key, filename: safeName, contentType: mime, sizeBytes: file.data.byteLength, width: null, height: null, createdAt: nowIso(), role: sourceId ? 'frame' as const : 'file' as const, sourceId, marksJson: marks ? JSON.stringify(marks) : null }
  try {
    await getDb(env.DB).insert(taskAttachments).values(row)
  }
  catch (error) {
    await requireFiles(env).delete(key)
    throw error
  }
  await writeAudit(env, { serverId: (await getServerId(cf(event).env.DB)), actorId: actor.user.id, action: 'task_attachment.create', targetType: 'task', targetId: taskId, meta: { attachmentId: id, filename: safeName } })
  waitUntil(signalTasksChanged(env, task.boardId, taskId))
  return { attachment: { id, taskId, uploaderId: actor.user.id, filename: safeName, contentType: mime, sizeBytes: file.data.byteLength, width: null, height: null, createdAt: row.createdAt, role: row.role, sourceId, marks, url: `/api/task-files/${id}` } }
})
