import { cf, fail } from '../../../utils/cf'

export default defineEventHandler(async (event) => {
  const { env, request } = cf(event)
  const workspaceId = getRouterParam(event, 'workspaceId')!
  if (!request || getHeader(event, 'upgrade') !== 'websocket') {
    fail(426, 'upgrade_required', 'Expected WebSocket')
  }
  return env.WORKSPACE_DO.getByName(`workspace:${workspaceId}`).fetch(request)
})
