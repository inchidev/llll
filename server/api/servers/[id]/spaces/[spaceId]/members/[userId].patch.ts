import { cf } from '../../../../../../utils/cf'
import { requireMember } from '../../../../../../utils/guards'
import { updateSpaceMember } from '../../../../../../utils/space-service'

export default defineEventHandler(async (event) => {
  const member = await requireMember(event, getRouterParam(event, 'id')!)
  await updateSpaceMember(cf(event).env, member, getRouterParam(event, 'spaceId')!, getRouterParam(event, 'userId')!, await readBody(event))
  return { ok: true }
})
