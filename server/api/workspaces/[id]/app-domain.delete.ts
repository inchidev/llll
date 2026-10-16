import { requireMember } from '../../../utils/guards'
import { cf, fail } from '../../../utils/cf'
import { disconnectManagedAppDomain, failInstallationControl } from '../../../utils/installation-control'

export default defineEventHandler(async (event) => {
  const member = await requireMember(event, getRouterParam(event, 'id')!)
  if (!member.isOwner) fail(403, 'forbidden', 'Only the owner can manage the App Domain')
  try {
    return await disconnectManagedAppDomain(cf(event).env)
  }
  catch (error) {
    failInstallationControl(error)
  }
})
