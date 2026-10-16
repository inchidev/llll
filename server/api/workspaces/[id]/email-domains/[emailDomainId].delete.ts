import { requireMember } from '../../../../utils/guards'
import { cf, fail } from '../../../../utils/cf'
import { disconnectManagedEmailDomain, failInstallationControl } from '../../../../utils/installation-control'

export default defineEventHandler(async (event) => {
  const member = await requireMember(event, getRouterParam(event, 'id')!)
  if (!member.isOwner) fail(403, 'forbidden', 'Only the owner can manage Email Domains')
  try {
    return await disconnectManagedEmailDomain(cf(event).env, getRouterParam(event, 'emailDomainId')!)
  }
  catch (error) {
    failInstallationControl(error)
  }
})
