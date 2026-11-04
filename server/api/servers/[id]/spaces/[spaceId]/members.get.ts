import { cf } from '../../../../../utils/cf'
import { requireMember } from '../../../../../utils/guards'
import { listSpaceMembers } from '../../../../../utils/space-service'

export default defineEventHandler(async (event) => {
  const member = await requireMember(event, getRouterParam(event, 'id')!)
  return { members: await listSpaceMembers(cf(event).env, member, getRouterParam(event, 'spaceId')!) }
})
