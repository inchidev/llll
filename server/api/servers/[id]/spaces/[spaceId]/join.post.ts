import { cf } from '../../../../../utils/cf'
import { requireMember } from '../../../../../utils/guards'
import { joinSpace } from '../../../../../utils/space-service'

export default defineEventHandler(async (event) => {
  const member = await requireMember(event, getRouterParam(event, 'id')!)
  return { space: await joinSpace(cf(event).env, member, getRouterParam(event, 'spaceId')!) }
})
