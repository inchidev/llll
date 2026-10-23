import { cf } from '../../../utils/cf'
import { privateChannelMembers, requirePrivateChannelManager } from '../../../utils/private-channel-members'

export default defineEventHandler(async event => {
  const id = getRouterParam(event, 'id')!
  await requirePrivateChannelManager(event, id)
  return { members: await privateChannelMembers(cf(event).env, id) }
})
