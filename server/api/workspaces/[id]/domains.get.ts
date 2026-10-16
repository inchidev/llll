import { requireMember } from '../../../utils/guards'
import { cf, fail } from '../../../utils/cf'
import { failInstallationControl, readManagedInstallationDomains } from '../../../utils/server-infrastructure'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const member = await requireMember(event, getRouterParam(event, 'id')!)
  if (!member.isOwner) fail(403, 'forbidden', 'Only the owner can manage Installation domains')
  try {
    return await readManagedInstallationDomains(cf(event).env)
  }
  catch (error) {
    failInstallationControl(error)
  }
})
