import { requireChannelAccess } from '../../../../utils/guards'
import { cf } from '../../../../utils/cf'
import { liveRoom } from '../../../../utils/live'

export default defineEventHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const access = await requireChannelAccess(event, channelId)
  const { env } = cf(event)
  return { joined: await liveRoom(env, channelId).pingLive(access.user.id) }
})
