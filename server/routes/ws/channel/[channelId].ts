import { cf, fail } from '../../../utils/cf'

export default defineEventHandler(async (event) => {
  const { env, request } = cf(event)
  const channelId = getRouterParam(event, 'channelId')!
  if (!request || getHeader(event, 'upgrade') !== 'websocket') {
    fail(426, 'upgrade_required', 'Expected WebSocket')
  }
  return env.CHANNEL_DO.getByName(`channel:${channelId}`).fetch(request)
})
