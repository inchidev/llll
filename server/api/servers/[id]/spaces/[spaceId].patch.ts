import { cf } from '../../../../utils/cf'
import { requireMember } from '../../../../utils/guards'
import { updateSpace } from '../../../../utils/space-service'

export default defineEventHandler(async (event) => {
  const member = await requireMember(event, getRouterParam(event, 'id')!)
  return { space: await updateSpace(cf(event).env, member, getRouterParam(event, 'spaceId')!, await readBody(event)) }
})
