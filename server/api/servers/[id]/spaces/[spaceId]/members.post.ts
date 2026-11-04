import { cf } from '../../../../../utils/cf'
import { requireMember } from '../../../../../utils/guards'
import { addSpaceMember } from '../../../../../utils/space-service'

export default defineEventHandler(async (event) => {
  const member = await requireMember(event, getRouterParam(event, 'id')!)
  await addSpaceMember(cf(event).env, member, getRouterParam(event, 'spaceId')!, await readBody(event))
  return { ok: true }
})
