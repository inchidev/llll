import { saveProjectPolicy } from '../../utils/project-policies'
import { requireMember } from '../../utils/guards'
import { getServerId } from '../../../shared/server-id'
import { cf } from '../../utils/cf'
import { signalMembersChanged } from '../../../workers/member-events'
import { revalidateLiveRooms } from '../../utils/live'
export default defineEventHandler(async event => {
  const { env, waitUntil } = cf(event), serverId = await getServerId(env.DB), actor = await requireMember(event, serverId)
  const policy = await saveProjectPolicy(env, actor.authorization, await readBody(event), getRouterParam(event, 'id')!)
  waitUntil(signalMembersChanged(env, serverId))
  waitUntil(revalidateLiveRooms(env))
  return { policy }
})
