import { requireChannelAccess } from '../../../utils/guards'
import { cf } from '../../../utils/cf'
import { failLive, liveRoom } from '../../../utils/live'
import { writeAudit } from '../../../utils/messages'

/** End the Live room for everyone. The room decides who is a host. */
export default defineEventHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const access = await requireChannelAccess(event, channelId)
  const { env } = cf(event)
  const result = await liveRoom(env, channelId).endLive(access.user.id)
  if (!result.ok) failLive(result)
  await writeAudit(env, { workspaceId: access.workspaceId, actorId: access.user.id, action: 'live.end', targetType: 'channel', targetId: channelId })
  return { live: result.live }
})
