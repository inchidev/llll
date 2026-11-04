import { cf } from '../../../../utils/cf'
import { requireMember } from '../../../../utils/guards'
import { listSpacesAdmin } from '../../../../utils/space-admin'

/** The Owner's table of Spaces: counts, never contents. */
export default defineEventHandler(async (event) => {
  const member = await requireMember(event, getRouterParam(event, 'id')!)
  const { env, waitUntil } = cf(event)
  return listSpacesAdmin(env, member, getQuery(event), waitUntil)
})
