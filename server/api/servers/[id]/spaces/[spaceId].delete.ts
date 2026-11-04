import { cf } from '../../../../utils/cf'
import { requireMember } from '../../../../utils/guards'
import { deleteSpace } from '../../../../utils/space-service'

export default defineEventHandler(async (event) => {
  const member = await requireMember(event, getRouterParam(event, 'id')!)
  await deleteSpace(cf(event).env, member, getRouterParam(event, 'spaceId')!)
  return { ok: true }
})
