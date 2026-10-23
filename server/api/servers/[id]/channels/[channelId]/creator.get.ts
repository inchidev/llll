import { z } from 'zod'
import { cf, fail } from '../../../../../utils/cf'
import { requireMember } from '../../../../../utils/guards'
import { creatorCandidates } from '../../../../../utils/channel-creator-recovery'

export default defineEventHandler(async event => {
  const actor = await requireMember(event, getRouterParam(event, 'id')!)
  if (!actor.isOwner) fail(403, 'forbidden', 'Only the Server owner can recover a missing channel creator')
  const { search } = z.object({ search: z.string().max(100).default('') }).parse(getQuery(event))
  return creatorCandidates(cf(event).env, getRouterParam(event, 'channelId')!, search)
})
