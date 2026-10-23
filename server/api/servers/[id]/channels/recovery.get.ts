import { z } from 'zod'
import { cf, fail } from '../../../../utils/cf'
import { requireMember } from '../../../../utils/guards'
import { orphanedPrivateChannels } from '../../../../utils/channel-creator-recovery'

export default defineEventHandler(async event => {
  const actor = await requireMember(event, getRouterParam(event, 'id')!)
  if (!actor.isOwner) fail(403, 'forbidden', 'Only the Server owner can recover a missing channel creator')
  const { page } = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1) }).parse(getQuery(event))
  return orphanedPrivateChannels(cf(event).env, page)
})
