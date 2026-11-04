import { cf } from '../../../../../../utils/cf'
import { requireMember } from '../../../../../../utils/guards'
import { removeSpaceMember } from '../../../../../../utils/space-service'

export default defineEventHandler(async (event) => {
  const member = await requireMember(event, getRouterParam(event, 'id')!)
  await removeSpaceMember(cf(event).env, member, getRouterParam(event, 'spaceId')!, getRouterParam(event, 'userId')!)
  return { ok: true }
})
