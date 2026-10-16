import { requireChannelAccess } from '../../../../utils/guards'
import { cf } from '../../../../utils/cf'
import { liveRoom } from '../../../../utils/live'

export default defineEventHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const access = await requireChannelAccess(event, channelId)
  const { env } = cf(event)
  return { live: await liveRoom(env, channelId).declineLive(access.user.id) }
})
