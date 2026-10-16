import { eq } from 'drizzle-orm'
import { roles, users } from '../../../../drizzle/schema'
import { hasPermission, Permission } from '../../../../shared/permissions'
import { requireMember } from '../../../utils/guards'
import { cf, fail } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import { toRoleDto } from '../../../utils/role-policy'

export default defineEventHandler(async (event) => {
  const workspaceId = getRouterParam(event, 'id')!
  const actor = await requireMember(event, workspaceId)
  if (!hasPermission(actor.perms, Permission.manageRoles)
    && !hasPermission(actor.perms, Permission.manageChannels)
    && !hasPermission(actor.perms, Permission.manageGadgets)) {
    fail(403, 'forbidden', 'Missing permission')
  }
  const { env } = cf(event)
  const db = getDb(env.DB)
  const [roleRows, memberRows] = await Promise.all([
    db.select().from(roles).orderBy(roles.position),
    db.select({ roleId: users.roleId }).from(users).where(eq(users.status, 'active')),
  ])
  const counts = new Map<string, number>()
  for (const member of memberRows) {
    if (member.roleId) counts.set(member.roleId, (counts.get(member.roleId) ?? 0) + 1)
  }
  return { roles: roleRows.map(role => toRoleDto(role, workspaceId, counts.get(role.id) ?? 0)) }
})
