import { cf, fail } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'

export default defineEventHandler(async (event) => {
  const member = await requireMember(event, getRouterParam(event, 'id')!)
  if (!member.isOwner) fail(403, 'forbidden', 'Only the owner can remove this server')
  if (cf(event).env.LLLL_SERVER_ID) fail(409, 'installation_managed_server', 'Back up this server, then ask the installation operator to remove its resources')
  fail(409, 'operator_managed_server', 'Back up this server, then remove its resources through your deployment operator')
})
