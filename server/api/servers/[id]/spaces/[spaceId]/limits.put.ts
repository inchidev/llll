import { cf } from '../../../../../utils/cf'
import { requireMember } from '../../../../../utils/guards'
import { setSpaceLimits } from '../../../../../utils/space-service'

export default defineEventHandler(async (event) => {
  const member = await requireMember(event, getRouterParam(event, 'id')!)
  return { space: await setSpaceLimits(cf(event).env, member, getRouterParam(event, 'spaceId')!, await readBody(event)) }
})
