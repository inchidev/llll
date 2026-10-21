import { getServerId } from '../../../shared/server-id'
import { requireUser } from '../../utils/auth'
import { cf, fail } from '../../utils/cf'
import { searchDmMembers } from '../../utils/dm-search'
import { requireMember } from '../../utils/guards'
import { hasPermission, Permission } from '../../../shared/permissions'

export default defineEventHandler(async (event) => {
  const me = await requireUser(event)
  const q = String(getQuery(event).q || '').trim().toLowerCase()
  const serverId = String(getQuery(event).serverId || (await getServerId(cf(event).env.DB)))
  if (serverId !== (await getServerId(cf(event).env.DB))) fail(404, 'not_found', 'Server not found')
  const member = await requireMember(event, serverId)
  const { env } = cf(event)
  return {
    members: await searchDmMembers(env.DB, me.id, q, member.isOwner || hasPermission(member.perms, Permission.useAgents)),
  }
})
