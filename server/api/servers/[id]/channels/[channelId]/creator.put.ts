import { z } from 'zod'
import { cf, fail } from '../../../../../utils/cf'
import { requireMember } from '../../../../../utils/guards'
import { assignMissingChannelCreator } from '../../../../../utils/channel-creator-recovery'
import { parseBody } from '../../../../../utils/validate'

export default defineEventHandler(async event => {
  const serverId = getRouterParam(event, 'id')!
  const actor = await requireMember(event, serverId)
  if (!actor.isOwner) fail(403, 'forbidden', 'Only the Server owner can recover a missing channel creator')
  const { userId } = parseBody(z.object({ userId: z.string().min(1).max(128) }), await readBody(event))
  return assignMissingChannelCreator(cf(event).env, serverId, actor.user.id, getRouterParam(event, 'channelId')!, userId)
})
