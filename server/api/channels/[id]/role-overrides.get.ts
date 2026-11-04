import { cf } from '../../../utils/cf'
import { listChannelRoleOverrides, requireChannelOverrideManager } from '../../../utils/channel-role-overrides'

export default defineEventHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  await requireChannelOverrideManager(event, channelId)
  return { overrides: await listChannelRoleOverrides(cf(event).env, channelId) }
})
