import { cf, fail } from '../../../utils/cf'

export default defineEventHandler(async (event) => {
  const { env, request } = cf(event)
  const serverId = getRouterParam(event, 'serverId')!
  if (!request || getHeader(event, 'upgrade') !== 'websocket') {
    fail(426, 'upgrade_required', 'Expected WebSocket')
  }
  return env.SERVER_DO.getByName(`server:${serverId}`).fetch(request)
})
