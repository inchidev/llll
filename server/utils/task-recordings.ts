import { resourceAllowed, type AuthorizationContext } from '../../shared/authorization'
import { BASIC_FILE_LIMIT, fileStorage } from '../../shared/file-storage'
import { newId, nowIso } from '../../shared/ids'
import { MAX_ATTACHMENT_BYTES } from '../../shared/mime'
import { hasPermission, Permission } from '../../shared/permissions'
import { readServerSetting, writeServerSetting } from '../../shared/server-settings'
import {
  coverFrame, MCP_FRAME_BYTES, MCP_FRAME_LIMIT, RECORDING_LIMIT_DEFAULT_MB, RECORDING_MAX_FRAMES, recordingFinishSchema, recordingFrameSchema, recordingSettingsSchema, recordingText, recordingTitle, SHOTS_BOARD_NAME, sniffRecordingType,
  type RecordingFrameMarks, type RecordingLimitsDTO, type RecordingSaid, type RecordingSettings,
} from '../../shared/task-recordings'
import type { TaskDetailDTO } from '../../shared/types'
import type { L4Env } from '../../workers/env'
import { signalTasksChanged } from '../../workers/task-events'
import { aiFunctionConfig, mediaAsText } from './ai-functions'
import { fail } from './cf'
import { auditStatement, writeAudit } from './messages'
import { spaceOfResource } from './space-access'
import { requireStorageQuota } from './space-quota'
import { requireTask, taskPermissionAllowed } from './task-policy'
import { insertTask, updateTask } from './task-service'
import { parseBody } from './validate'

type Schedule = (promise: Promise<unknown>) => void

export async function readRecordingSettings(env: L4Env): Promise<RecordingSettings> {
  return { maxUploadMb: Number(await readServerSetting(env.DB, 'tasks.max_recording_mb')) || RECORDING_LIMIT_DEFAULT_MB }
}

export async function saveRecordingSettings(env: L4Env, auth: AuthorizationContext, request: unknown): Promise<RecordingSettings> {
  const input = parseBody(recordingSettingsSchema, request)
  await writeServerSetting(env.DB, 'tasks.max_recording_mb', String(input.maxUploadMb))
  await writeAudit(env, { serverId: auth.serverId, actorId: auth.principal.id, action: 'tasks.recording_limit.update', targetType: 'server', targetId: auth.serverId, meta: input, authorization: auth })
  return input
}

/** Basic storage has its own smaller ceiling, whatever the setting says. */
export async function recordingLimits(env: L4Env): Promise<RecordingLimitsDTO> {
  const [settings, backend, transcription] = await Promise.all([readRecordingSettings(env), readServerSetting(env.DB, 'storage.backend'), env.AI ? null : aiFunctionConfig(env, 'audio.transcribe')])
  const configured = settings.maxUploadMb * 1024 * 1024
  return { maxUploadBytes: !env.FILES || backend === 'kv' ? Math.min(configured, BASIC_FILE_LIMIT) : configured, voice: Boolean(env.AI) || Boolean(transcription?.model) }
}

/** Refused before anything is stored: what the request says about its size. */
function requireRecordingSize(limits: RecordingLimitsDTO, body: unknown, declaredSize: number) {
  if (!body || !Number.isFinite(declaredSize) || declaredSize <= 0) fail(411, 'length_required', 'Choose a recording or screenshot to upload')
  if (declaredSize > limits.maxUploadBytes) fail(413, 'too_large', `That file is over ${Math.floor(limits.maxUploadBytes / (1024 * 1024))} MB. Trim the recording and try again.`)
}

/** The body streams straight through: nothing here reads it except the first bytes, for its type. */
async function storeRecording(env: L4Env, serverId: string, folder: string, body: ReadableStream<Uint8Array> | Uint8Array, name: string, limits: RecordingLimitsDTO) {
  const id = newId(), safeName = name.replace(/[^\w.-]+/gu, '_').slice(0, 80) || 'recording', key = `${serverId}/${folder}/${id}-${safeName}`, files = fileStorage(env)
  await files.put(key, body as ReadableStream<Uint8Array>)
  const head = await files.get(key, { range: { offset: 0, length: 32 } })
  const contentType = head ? sniffRecordingType(new Uint8Array(await head.arrayBuffer())) : null
  const stored = await files.head(key)
  if (!contentType || !stored || stored.size > limits.maxUploadBytes) {
    await files.delete(key)
    if (!contentType) fail(415, 'unsupported_type', 'A recording is MP4, MOV, WebM, PNG, JPEG, WebP or GIF.')
    fail(413, 'too_large', 'That file is over the limit.')
  }
  return { id, key, safeName, contentType, sizeBytes: stored.size }
}

/** The attachment row for a stored file. If it can't be saved, the file goes too. */
async function attachRecording(env: L4Env, auth: AuthorizationContext, taskId: string, boardId: string, file: Awaited<ReturnType<typeof storeRecording>>, schedule: Schedule, storeMs?: number) {
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO task_attachments(id,task_id,uploader_id,r2_key,filename,content_type,size_bytes,role,created_at) VALUES(?,?,?,?,?,?,?,'recording',?)`)
        .bind(file.id, taskId, auth.principal.id, file.key, file.safeName, file.contentType, file.sizeBytes, nowIso()),
      await auditStatement(env, { serverId: auth.serverId, actorId: auth.principal.id, action: 'task_attachment.create', targetType: 'task', targetId: taskId, meta: { attachmentId: file.id, role: 'recording', sizeBytes: file.sizeBytes, ...(storeMs === undefined ? {} : { storeMs }) }, authorization: auth }),
    ])
  }
  catch (error) {
    await fileStorage(env).delete(file.key)
    throw error
  }
  schedule(signalTasksChanged(env, boardId, taskId))
  return { id: file.id, taskId, filename: file.safeName, contentType: file.contentType, sizeBytes: file.sizeBytes, url: `/api/task-files/${file.id}` }
}

/** Saves a recording or screenshot as an open Task's attachment. */
export async function createRecording(env: L4Env, auth: AuthorizationContext, taskReference: string, body: ReadableStream<Uint8Array> | Uint8Array | null, declaredSize: number, name: string, schedule: Schedule) {
  const task = await requireTask(env, taskReference, auth, Permission.writeTasks)
  if (!auth.principal.isOwner && !hasPermission(auth.principal.permissions, Permission.attachFiles)) fail(403, 'forbidden', 'Missing attach-files permission')
  const spaceId = await spaceOfResource(env, 'task', task.id)
  const limits = await recordingLimits(env)
  requireRecordingSize(limits, body, declaredSize)
  if (spaceId) await requireStorageQuota(env, spaceId, declaredSize)
  const file = await storeRecording(env, auth.serverId, `tasks/${task.id}`, body!, name, limits)
  return attachRecording(env, auth, task.id, task.boardId, file, schedule)
}

/** The first board in this Space, in this order, that the person can add Tasks to. */
async function writableBoard(env: L4Env, auth: AuthorizationContext, spaceId: string, where: string, ...bindings: string[]) {
  const boards = (await env.DB.prepare(`SELECT b.id FROM task_boards b
    WHERE b.space_id = ? AND b.archived_at IS NULL AND ${where} ORDER BY b.position, b.id`).bind(spaceId, ...bindings).all<{ id: string }>()).results
  return boards.find(board => taskPermissionAllowed(auth, { boardId: board.id, projectId: null }, Permission.writeTasks))?.id ?? null
}

/**
 * Where a recording lands: the board this device chose, or the Space's Shots board,
 * made on first use. Someone whose Role can't use that one gets the first board they can.
 */
async function recordingBoard(env: L4Env, auth: AuthorizationContext, spaceId: string, chosen: string | null) {
  const remembered = chosen ? await writableBoard(env, auth, spaceId, 'b.id = ?', chosen) : null
  if (remembered) return remembered
  const shots = await writableBoard(env, auth, spaceId, 'b.name = ?', SHOTS_BOARD_NAME)
  if (shots) return shots
  if (auth.principal.isOwner || (hasPermission(auth.principal.permissions, Permission.writeTasks) && resourceAllowed(auth, 'boards', '*'))) {
    const id = newId(), now = nowIso()
    const made = await env.DB.prepare(`INSERT INTO task_boards(id,space_id,name,position,created_by,created_at,updated_at)
      SELECT ?,?,?,COALESCE((SELECT max(position) FROM task_boards WHERE space_id=?),0)+1024,?,?,?
      WHERE NOT EXISTS(SELECT 1 FROM task_boards WHERE space_id=? AND name=? AND archived_at IS NULL)`).bind(id, spaceId, SHOTS_BOARD_NAME, spaceId, auth.principal.id, now, now, spaceId, SHOTS_BOARD_NAME).run()
    if (made.meta.changes) {
      await writeAudit(env, { serverId: auth.serverId, actorId: auth.principal.id, action: 'board.create', targetType: 'task_board', targetId: id, meta: { name: SHOTS_BOARD_NAME }, authorization: auth })
      return id
    }
  }
  const any = await writableBoard(env, auth, spaceId, '1 = 1')
  if (!any) fail(403, 'forbidden', 'Your Role can’t add Tasks in this Space')
  return any
}

/**
 * A file that reaches the Server before anyone marked it, as from a phone: it becomes a normal Task
 * at once, and marking updates that Task. The file is stored first, so a refused file leaves no Task
 * and no board. The phone waits on every query here, so nothing is asked twice.
 */
export async function createTaskFromRecording(env: L4Env, auth: AuthorizationContext, spaceId: string, chosenBoard: string | null, body: ReadableStream<Uint8Array> | Uint8Array | null, declaredSize: number, name: string, schedule: Schedule) {
  if (!auth.principal.isOwner && !hasPermission(auth.principal.permissions, Permission.attachFiles)) fail(403, 'forbidden', 'Missing attach-files permission')
  const limits = await recordingLimits(env)
  requireRecordingSize(limits, body, declaredSize)
  await requireStorageQuota(env, spaceId, declaredSize)
  // Reading the body waits on the phone. Kept in the audit row, to tell that wait from the Server's own.
  const storing = Date.now()
  const file = await storeRecording(env, auth.serverId, 'tasks/arrivals', body!, name, limits)
  const storeMs = Date.now() - storing
  try {
    const boardId = await recordingBoard(env, auth, spaceId, chosenBoard)
    const taskId = await insertTask(env, auth, boardId, { title: recordingTitle([], [], file.contentType.startsWith('image/')), description: '', priority: 'normal', dueAt: null, assigneeId: null, channelId: null, labelIds: [], dependencyIds: [] }, schedule)
    const attachment = await attachRecording(env, auth, taskId, boardId, file, schedule, storeMs)
    return { taskId, attachment, boardId }
  }
  catch (error) {
    await fileStorage(env).delete(file.key)
    throw error
  }
}

/** Saves the marks, puts the words in the Task's text, and gives a Task without a cover its best frame. */
export async function finishRecording(env: L4Env, auth: AuthorizationContext, attachmentId: string, request: unknown, schedule: Schedule): Promise<TaskDetailDTO> {
  const input = parseBody(recordingFinishSchema, request)
  const recording = await env.DB.prepare("SELECT task_id AS taskId, content_type AS contentType FROM task_attachments WHERE id=? AND role='recording'").bind(attachmentId).first<{ taskId: string; contentType: string }>()
  if (!recording) fail(404, 'not_found', 'Attachment not found')
  const task = await requireTask(env, recording.taskId, auth, Permission.writeTasks)
  const frames = (await env.DB.prepare("SELECT id, marks_json AS marks FROM task_attachments WHERE source_id=? AND role='frame' ORDER BY filename").bind(attachmentId).all<{ id: string; marks: string | null }>()).results ?? []
  const marks = { duration: input.duration, clips: input.clips }
  await env.DB.prepare('UPDATE task_attachments SET marks_json=? WHERE id=?').bind(JSON.stringify(marks), attachmentId).run()
  const image = recording.contentType.startsWith('image/')
  const text = recordingText(marks, input.transcript, image)
  // The title the Task got on arrival gives way to the first thing said or written about it.
  const title = recordingTitle(input.clips, input.transcript, image)
  const cover = coverFrame(frames.map(frame => ({ id: frame.id, marks: frame.marks ? JSON.parse(frame.marks) as RecordingFrameMarks : null })))?.id ?? (image ? attachmentId : undefined)
  return updateTask(env, auth, task.id, {
    ...(task.title === recordingTitle([], [], image) && title !== task.title ? { title } : {}),
    ...(text ? { description: [task.description, text].filter(Boolean).join('\n\n').slice(0, 12_000) } : {}),
    ...(cover && !task.coverAttachmentId ? { coverAttachmentId: cover } : {}),
  }, schedule)
}

export type RecordingFrameUpload = { name: string; data: Uint8Array; marks: unknown }

/**
 * A device key's marks and frames, which the apps send as one request once the file is up. Only the
 * person's own recording, in the key's Space. Sent twice, the second changes nothing.
 */
export async function saveRecordingMarks(env: L4Env, auth: AuthorizationContext, spaceId: string, taskReference: string, frames: RecordingFrameUpload[], request: unknown, schedule: Schedule): Promise<void> {
  const task = await requireTask(env, taskReference, auth, Permission.writeTasks)
  if (await spaceOfResource(env, 'task', task.id) !== spaceId) fail(404, 'not_found', 'Task not found')
  const recording = await env.DB.prepare("SELECT id, marks_json AS marks FROM task_attachments WHERE task_id=? AND role='recording' AND uploader_id=? ORDER BY created_at DESC").bind(task.id, auth.principal.id).first<{ id: string; marks: string | null }>()
  if (!recording) fail(404, 'not_found', 'Recording not found')
  if (recording.marks) return
  if (frames.length > RECORDING_MAX_FRAMES) fail(400, 'bad_request', 'Too many frames')
  const parsed = frames.map((frame) => {
    if (sniffRecordingType(frame.data) !== 'image/jpeg' || frame.data.byteLength > MAX_ATTACHMENT_BYTES) fail(400, 'bad_request', 'A frame is a JPEG of this recording')
    return { ...frame, marks: parseBody(recordingFrameSchema, frame.marks), safeName: frame.name.replace(/[^\w.-]+/gu, '_').slice(0, 80) || 'frame.jpg' }
  })
  const total = parsed.reduce((sum, frame) => sum + frame.data.byteLength, 0)
  await requireStorageQuota(env, spaceId, total)
  const files = fileStorage(env), now = nowIso(), stored: string[] = []
  try {
    const rows = []
    for (const frame of parsed) {
      const id = newId(), key = `${auth.serverId}/tasks/${task.id}/${id}-${frame.safeName}`
      await files.put(key, frame.data, { httpMetadata: { contentType: 'image/jpeg' } })
      stored.push(key)
      rows.push(env.DB.prepare(`INSERT INTO task_attachments(id,task_id,uploader_id,r2_key,filename,content_type,size_bytes,role,source_id,marks_json,created_at) VALUES(?,?,?,?,?,'image/jpeg',?,'frame',?,?,?)`)
        .bind(id, task.id, auth.principal.id, key, frame.safeName, frame.data.byteLength, recording.id, JSON.stringify(frame.marks), now))
    }
    if (rows.length) await env.DB.batch(rows)
  }
  catch (error) {
    await Promise.allSettled(stored.map(key => files.delete(key)))
    throw error
  }
  await finishRecording(env, auth, recording.id, request, schedule)
}

type WhisperResult = { text?: string; segments?: Array<{ start?: number; end?: number; text?: string }> }

/**
 * One chunk of 16 kHz mono WAV, cut in the browser, into timed phrases. Workers AI gives times; a
 * configured Voice transcription model gives text for the whole chunk. The audio is not kept or logged.
 */
export async function transcribeRecordingVoice(env: L4Env, actorId: string, audio: Uint8Array, at: number): Promise<RecordingSaid[]> {
  const seconds = Math.max(0, (audio.length - 44) / 32_000)
  if (env.AI) {
    let result: WhisperResult
    try {
      result = await (env.AI as unknown as { run: (model: string, input: unknown) => Promise<WhisperResult> }).run('@cf/openai/whisper-large-v3-turbo', { audio: btoa(Array.from(audio, byte => String.fromCharCode(byte)).join('')), vad_filter: true, condition_on_previous_text: false })
    }
    catch { fail(502, 'voice_failed', 'Transcription did not work this time. Try again, or type it.') }
    const timed = (result.segments ?? []).flatMap((segment) => {
      const text = segment.text?.trim()
      return text ? [{ start: at + (segment.start ?? 0), end: at + (segment.end ?? seconds), text }] : []
    })
    return timed.length || !result.text?.trim() ? timed : [{ start: at, end: at + seconds, text: result.text.trim() }]
  }
  const transcript = await mediaAsText(env, 'audio.transcribe', actorId, { bytes: audio, mediaType: 'audio/wav', name: 'voice.wav' })
  if (!('text' in transcript)) fail(transcript.status === 'unset' ? 409 : 502, 'voice_failed', transcript.status === 'unset' ? 'No voice transcription is set up on this Server.' : 'Transcription did not work this time. Try again, or type it.')
  const text = transcript.text.trim()
  return text ? [{ start: at, end: at + seconds, text }] : []
}

/** A Task's frames as MCP content, within what one answer should carry. The caller has checked access to the Task. */
export async function taskFrameContent(env: L4Env, task: Pick<TaskDetailDTO, 'id'>) {
  const rows = (await env.DB.prepare("SELECT filename, r2_key AS key FROM task_attachments WHERE task_id=? AND role='frame' ORDER BY filename").bind(task.id).all<{ filename: string; key: string }>()).results ?? []
  if (!rows.length) return []
  const files = fileStorage(env), content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = []
  let bytes = 0, shown = 0
  for (const frame of rows.slice(0, MCP_FRAME_LIMIT)) {
    const object = await files.get(frame.key)
    if (!object) continue
    const data = new Uint8Array(await object.arrayBuffer())
    if (bytes + data.length > MCP_FRAME_BYTES) break
    bytes += data.length
    shown++
    content.push({ type: 'text', text: `frame ${frame.filename}` }, { type: 'image', data: btoa(Array.from(data, byte => String.fromCharCode(byte)).join('')), mimeType: 'image/jpeg' })
  }
  if (shown < rows.length) content.push({ type: 'text', text: `${rows.length - shown} more frame(s) not included to keep this response small.` })
  return content
}
