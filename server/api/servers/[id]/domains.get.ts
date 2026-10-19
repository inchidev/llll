import { requireMember } from '../../../utils/guards'
import { cf, fail } from '../../../utils/cf'
import { failServerControl, readManagedServerDomains } from '../../../utils/server-infrastructure'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const member = await requireMember(event, getRouterParam(event, 'id')!)
  if (!member.isOwner) fail(403, 'forbidden', 'Only the owner can manage Server domains')
  try {
    return await readManagedServerDomains(cf(event).env)
  }
  catch (error) {
    failServerControl(error)
  }
})
