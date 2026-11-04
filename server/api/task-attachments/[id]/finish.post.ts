import { getServerId } from '../../../../shared/server-id'
import { cf } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { finishRecording } from '../../../utils/task-recordings'

export default defineEventHandler(async (event) => {
  const { env, waitUntil } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB))
  return { task: await finishRecording(env, actor.authorization, getRouterParam(event, 'id')!, await readBody(event), waitUntil) }
})
