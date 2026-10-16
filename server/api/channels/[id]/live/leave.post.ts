import { requireUser } from '../../../../utils/auth'
import { cf } from '../../../../utils/cf'
import { liveRoom } from '../../../../utils/live'

// Leaving needs no current access: someone who just lost access must still be able to go.
// Also sent with navigator.sendBeacon when the page closes.
export default defineEventHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const user = await requireUser(event)
  const { env } = cf(event)
  return { live: await liveRoom(env, channelId).leaveLive(user.id) }
})
