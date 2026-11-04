import { getServerId } from '../../shared/server-id'
import { recordingEditorPath } from '../../shared/task-recordings'
import { cf, fail } from '../utils/cf'
import { requireMember } from '../utils/guards'
import { recordingKeyOf, recordingUploadProblem } from '../utils/recording-keys'
import { createTaskFromRecording } from '../utils/task-recordings'

/**
 * A recording or screenshot as the raw body, to a personal link. It becomes a Task right away, and
 * the answer is the address to mark it at. On a Worker the body streams; the entry point leaves it unread.
 */
export default defineEventHandler(async (event) => {
  try {
    const { env, request, waitUntil } = cf(event)
    const actor = await requireMember(event, await getServerId(env.DB))
    const key = recordingKeyOf(event)
    if (!key) fail(401, 'unauthorized', 'This link does not work')
    const body = request?.body ?? await readRawBody(event, false) ?? null
    const name = typeof getQuery(event).name === 'string' ? String(getQuery(event).name) : 'recording'
    const { taskId } = await createTaskFromRecording(env, actor.authorization, key.spaceId, key.boardId, body as ReadableStream<Uint8Array> | Uint8Array | null, Number(getHeader(event, 'content-length')), name, waitUntil)
    setResponseHeader(event, 'Cache-Control', 'no-store')
    setResponseHeader(event, 'Content-Type', 'text/plain; charset=utf-8')
    return `${getRequestURL(event).origin}${recordingEditorPath(taskId, key.spaceId, key.id)}`
  }
  catch (error) {
    const problem = recordingUploadProblem(event, error)
    if (problem) return problem
    throw error
  }
})
