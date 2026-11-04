import { getServerId } from '../../../../shared/server-id'
import { cf } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { createRecording } from '../../../utils/task-recordings'

/** The raw recording or screenshot as the body. On a Worker it streams; the entry point leaves it unread. */
export default defineEventHandler(async (event) => {
  const { env, request, waitUntil } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB))
  const body = request?.body ?? await readRawBody(event, false) ?? null
  const name = typeof getQuery(event).name === 'string' ? String(getQuery(event).name) : 'recording'
  return { attachment: await createRecording(env, actor.authorization, getRouterParam(event, 'id')!, body as ReadableStream<Uint8Array> | Uint8Array | null, Number(getHeader(event, 'content-length')), name, waitUntil) }
})
