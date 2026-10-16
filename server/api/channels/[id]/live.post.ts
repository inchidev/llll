import { requireChannelAccess } from '../../../utils/guards'
import { cf } from '../../../utils/cf'
import { failLive, liveRoom } from '../../../utils/live'

/** Join the conversation's Live room, starting it when it is idle. Returns the RealtimeKit participant token. */
export default defineEventHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const access = await requireChannelAccess(event, channelId)
  const { env } = cf(event)
  const { id, kind, displayName, avatarR2Key } = access.user
  const result = await liveRoom(env, channelId).joinLive({ id, kind, displayName, avatarR2Key })
  if (!result.ok) failLive(result)
  setHeader(event, 'Cache-Control', 'no-store')
  return { token: result.token, meetingId: result.meetingId, live: result.live }
})
