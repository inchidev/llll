import { cf } from '../../../../../utils/cf'
import { requireMember } from '../../../../../utils/guards'
import { refreshSpaceStats, requireSpaceAdmin } from '../../../../../utils/space-admin'

/** Counts now, rather than at the next stale load. */
export default defineEventHandler(async (event) => {
  requireSpaceAdmin(await requireMember(event, getRouterParam(event, 'id')!))
  return { refreshedAt: await refreshSpaceStats(cf(event).env) }
})
